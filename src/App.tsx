/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Terminal, 
  Activity, 
  Download, 
  Trash2, 
  History as HistoryIcon,
  Globe,
  Wifi,
  AlertCircle,
  ArrowLeft,
  LayoutGrid,
  LogOut
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface ScanEvent {
  type: 'start' | 'live' | 'progress' | 'end' | 'error';
  total?: number;
  ip?: string;
  scanned?: number;
  liveCount?: number;
  message?: string;
}

interface ScanHistory {
  id: string;
  cidr: string;
  timestamp: string;
  liveCount: number;
  total: number;
}

const TerminalLog = ({ logs }: { logs: string[] }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div 
      ref={scrollRef}
      className="bg-black border border-border rounded-sm p-4 h-full font-mono text-[11px] leading-relaxed overflow-y-auto custom-scrollbar text-accent"
    >
      {logs.map((log, i) => (
        <div key={i} className="mb-0.5">
          <span className="text-zinc-600 mr-2">[{new Date().toLocaleTimeString([], { hour12: false })}]</span>
          {log}
        </div>
      ))}
      <div className="animate-pulse inline-block w-1.5 h-3.5 bg-accent ml-1 align-middle" />
    </div>
  );
};

export default function App() {
  const [view, setView] = useState<'menu' | 'scan'>('menu');
  const [cidr, setCidr] = useState('192.168.1.0/24');
  const [isScanning, setIsScanning] = useState(false);
  const [timeout, setTimeoutVal] = useState(1);
  const [progress, setProgress] = useState({ scanned: 0, total: 0, liveCount: 0 });
  const [liveIps, setLiveIps] = useState<string[]>([]);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState('00:00:00');
  const [logs, setLogs] = useState<string[]>([]);
  const [history, setHistory] = useState<ScanHistory[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('cidr_history');
    if (saved) setHistory(JSON.parse(saved));
  }, []);

  useEffect(() => {
    let interval: any;
    if (isScanning && startTime) {
      interval = setInterval(() => {
        const diff = Date.now() - startTime;
        const h = Math.floor(diff / 3600000).toString().padStart(2, '0');
        const m = Math.floor((diff % 3600000) / 60000).toString().padStart(2, '0');
        const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
        setElapsed(`${h}:${m}:${s}`);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isScanning, startTime]);

  const saveHistory = (newEntry: ScanHistory) => {
    const updated = [newEntry, ...history].slice(0, 5);
    setHistory(updated);
    localStorage.setItem('cidr_history', JSON.stringify(updated));
  };

  const startScan = () => {
    if (isScanning) {
      stopScan();
      return;
    }
    setLiveIps([]);
    setProgress({ scanned: 0, total: 0, liveCount: 0 });
    setStartTime(Date.now());
    setElapsed('00:00:00');
    setLogs(['信息: 正在初始化网络扫描...', `信息: 扫描目标已定义为 ${cidr}`]);
    setIsScanning(true);

    const es = new EventSource(`/api/scan?cidr=${encodeURIComponent(cidr)}&timeout=${timeout}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      const data: ScanEvent = JSON.parse(event.data);
      switch (data.type) {
        case 'start':
          setLogs(prev => [...prev, `信息: 正在枚举 ${data.total} 个主机地址...`]);
          setProgress(prev => ({ ...prev, total: data.total || 0 }));
          break;
        case 'live':
          setLiveIps(prev => [...prev, data.ip!]);
          setProgress(prev => ({ ...prev, liveCount: prev.liveCount + 1 }));
          setLogs(prev => [...prev, `✅ 在线: ${data.ip}`]);
          break;
        case 'progress':
          setProgress({ 
            scanned: data.scanned || 0, 
            total: data.total || 0, 
            liveCount: data.liveCount || 0 
          });
          if (data.scanned! % 25 === 0) {
            setLogs(prev => [...prev, `进度: 已处理 ${data.scanned} / ${data.total}...`]);
          }
          break;
        case 'error':
          setLogs(prev => [...prev, `❌ 错误: ${data.message}`]);
          setIsScanning(false);
          es.close();
          break;
        case 'end':
          setLogs(prev => [...prev, `成功: 扫描完成。发现 ${data.liveCount} 个在线节点。`]);
          setIsScanning(false);
          saveHistory({
            id: Date.now().toString(),
            cidr,
            timestamp: new Date().toLocaleString(),
            liveCount: data.liveCount || 0,
            total: data.scanned || 0
          });
          es.close();
          break;
      }
    };

    es.onerror = () => {
      setLogs(prev => [...prev, '严重错误: 与扫描服务断开连接（请检查网络或 CIDR 范围）。']);
      setIsScanning(false);
      es.close();
    };
  };

  const stopScan = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      setLogs(prev => [...prev, '⛔ 停止: 用户已手动中止扫描。']);
      setIsScanning(false);
    }
  };

  const downloadResults = () => {
    const content = `# CIDR 扫描报告\n# 扫描时间: ${new Date().toLocaleString()}\n# 目标 CIDR: ${cidr}\n# 扫描总数: ${progress.scanned}\n# 在线总数: ${liveIps.length}\n` + "-".repeat(30) + "\n" + liveIps.join('\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `live_ips_${cidr.replace('/', '_')}.txt`;
    a.click();
  };

  if (view === 'menu') {
    return (
      <div className="h-screen bg-bg text-zinc-100 flex items-center justify-center font-sans">
        <div className="w-[500px] border border-border bg-surface p-8 shadow-2xl relative overflow-hidden backdrop-blur-xl">
          <div className="absolute top-0 left-0 w-full h-1 bg-accent/20" />
          
          <div className="text-center mb-10">
            <h1 className="text-2xl font-black tracking-[4px] uppercase mb-2">CIDR_SCANNER v2.4</h1>
            <p className="text-[10px] text-accent font-bold tracking-[2px] uppercase opacity-60">高性能网络探测终端</p>
          </div>

          <div className="space-y-4">
            <button 
              onClick={() => setView('scan')}
              className="w-full bg-accent text-black font-bold py-4 rounded-sm flex items-center justify-between px-6 group hover:translate-x-1 transition-all active:scale-95"
            >
              <div className="flex items-center gap-4">
                <span className="text-xs opacity-50">01</span>
                <span className="tracking-widest">开始新的扫描</span>
              </div>
              <Globe className="w-5 h-5 group-hover:rotate-12 transition-transform" />
            </button>

            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={() => setView('scan')}
                className="bg-[#1a1a1a] border border-border py-4 font-bold rounded-sm flex flex-col items-center gap-2 hover:border-accent transition-all group"
              >
                <Activity className="w-5 h-5 text-accent opacity-50 group-hover:opacity-100" />
                <span className="text-[10px] tracking-widest uppercase font-mono">参数配置</span>
              </button>
              <button 
                onClick={() => setView('scan')}
                className="bg-[#1a1a1a] border border-border py-4 font-bold rounded-sm flex flex-col items-center gap-2 hover:border-accent transition-all group"
              >
                <HistoryIcon className="w-5 h-5 text-accent opacity-50 group-hover:opacity-100" />
                <span className="text-[10px] tracking-widest uppercase font-mono">历史结果</span>
              </button>
            </div>

            <button 
              className="w-full border border-border text-zinc-500 font-bold py-3 rounded-sm flex items-center justify-between px-6 hover:text-rose-500 hover:border-rose-500/30 transition-all opacity-50"
              onClick={() => {}}
            >
              <div className="flex items-center gap-4">
                <span className="text-xs">04</span>
                <span className="text-[10px] uppercase tracking-widest">退出系统</span>
              </div>
              <LogOut className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-12 pt-6 border-t border-white/5 flex justify-between items-center text-[10px] text-zinc-600 font-mono">
            <span className="flex items-center gap-2"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> 系统就绪</span>
            <span>v2.4.2-PRO</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-bg text-zinc-100 font-sans overflow-hidden flex flex-col selection:bg-accent selection:text-black">
      {/* Header */}
      <header className="h-[60px] border-b border-border bg-surface px-6 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-6">
          <button 
            onClick={() => {
              if (isScanning) stopScan();
              setView('menu');
            }}
            className="flex items-center gap-2 text-zinc-500 hover:text-accent transition-colors group"
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
            <span className="text-[10px] font-bold uppercase tracking-wider">返回主菜单</span>
          </button>
          <div className="h-4 w-[1px] bg-border" />
          <div className="flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-accent shadow-[0_0_8px_theme(colors.accent)]" />
            <h1 className="text-[14px] font-bold tracking-widest uppercase">CIDR 扫描助手 v2.4</h1>
          </div>
        </div>
        
        <div className="flex gap-3">
          <button 
            onClick={stopScan}
            disabled={!isScanning}
            className="btn btn-danger text-[10px] font-bold tracking-wider py-1.5 px-4 bg-rose-600 text-white rounded-sm active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed transition-all uppercase"
          >
            停止 (Q)
          </button>
          <button 
            onClick={startScan}
            disabled={isScanning}
            className="btn btn-primary text-[10px] font-bold tracking-wider py-1.5 px-4 bg-accent text-black rounded-sm active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed transition-all uppercase"
          >
            {isScanning ? '扫描中...' : '开始扫描'}
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Sidebar Left */}
        <aside className="w-[240px] border-r border-border bg-surface p-5 flex flex-col gap-6 shrink-0">
          <div className="space-y-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-text-secondary uppercase tracking-[1px]">目标 CIDR 地址段</label>
              <input 
                type="text" 
                value={cidr}
                onChange={(e) => setCidr(e.target.value)}
                disabled={isScanning}
                className="bg-black border border-border text-white p-2 font-mono text-[12px] outline-none focus:border-accent transition-colors disabled:opacity-50"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[10px] font-bold text-text-secondary uppercase tracking-[1px]">超时时间 (秒)</label>
              <input 
                type="number" 
                value={timeout}
                onChange={(e) => setTimeoutVal(parseInt(e.target.value))}
                disabled={isScanning}
                className="bg-black border border-border text-white p-2 font-mono text-[12px] outline-none focus:border-accent transition-colors disabled:opacity-50"
              />
            </div>
          </div>

          <div className="mt-auto">
            <label className="text-[10px] font-bold text-text-secondary uppercase tracking-[1px] mb-3 block">历史记录</label>
            <div className="space-y-2 max-h-[200px] overflow-y-auto custom-scrollbar pr-1">
              {history.map((entry) => (
                <div key={entry.id} className="text-[11px] leading-tight flex flex-col border-b border-white/5 pb-2">
                  <span className="font-mono text-zinc-400">• {entry.cidr}</span>
                  <div className="flex justify-between items-center mt-1">
                    <span className="text-[9px] text-zinc-600 uppercase">发现 {entry.liveCount} 个节点</span>
                    <button onClick={() => setCidr(entry.cidr)} className="text-[9px] text-accent hover:underline">加载</button>
                  </div>
                </div>
              ))}
              {history.length === 0 && <span className="text-[11px] text-zinc-700 italic">暂无历史记录。</span>}
            </div>
          </div>
        </aside>

        {/* Main Panel Center */}
        <main className="flex-1 bg-bg p-6 flex flex-col gap-6 overflow-hidden">
          {/* Stats Grid */}
          <div className="grid grid-cols-3 gap-4 shrink-0">
            <div className="bg-[#1a1a1a] border border-border p-3 rounded-sm">
              <p className="text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">IP 总数</p>
              <p className="font-mono text-lg font-bold text-accent">{progress.total.toLocaleString()}</p>
            </div>
            <div className="bg-[#1a1a1a] border border-border p-3 rounded-sm">
              <p className="text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">在线主机</p>
              <p className="font-mono text-lg font-bold text-accent">{progress.liveCount}</p>
            </div>
            <div className="bg-[#1a1a1a] border border-border p-3 rounded-sm relative overflow-hidden group">
              <p className="text-[10px] font-bold text-text-secondary uppercase tracking-wider mb-1">累计耗时</p>
              <p className="font-mono text-lg font-bold text-accent">{elapsed}</p>
            </div>
          </div>

          {/* Progress Section */}
          <div className="shrink-0">
            <div className="flex justify-between items-end mb-2">
              <label className="text-[10px] font-bold text-text-secondary uppercase tracking-widest">实时扫描进度池_运行中</label>
              <span className="font-mono text-[12px] text-accent">
                {progress.total > 0 ? ((progress.scanned / progress.total) * 100).toFixed(1) : '0.0'}%
              </span>
            </div>
            <div className="h-2 bg-[#222] border border-border rounded-full overflow-hidden">
              <motion.div 
                className="h-full bg-accent shadow-[0_0_10px_rgba(0,255,102,0.5)]"
                initial={{ width: 0 }}
                animate={{ width: `${progress.total > 0 ? (progress.scanned / progress.total) * 100 : 0}%` }}
              />
            </div>
          </div>

          {/* Terminal Console */}
          <div className="flex-1 min-h-0 relative flex flex-col">
            <div className="absolute top-2 right-4 z-10">
              <div className="flex items-center gap-2">
                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                <span className="text-[9px] font-bold text-accent tracking-tighter uppercase">实时指令台</span>
              </div>
            </div>
            <TerminalLog logs={logs} />
          </div>
        </main>

        {/* Sidebar Right - Results Registry */}
        <aside className="w-[300px] border-l border-border bg-surface flex flex-col overflow-hidden shrink-0">
          <div className="p-5 border-b border-border bg-[#1a1a1a]">
            <h3 className="text-[11px] font-bold uppercase tracking-[1.5px] flex items-center gap-2">
              <Globe className="w-3 h-3 text-accent" /> 在线主机名录
            </h3>
          </div>
          
          <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
            <div className="flex flex-col gap-2">
              <AnimatePresence>
                {liveIps.map((ip) => (
                  <motion.div 
                    key={ip}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-center justify-between font-mono text-[12px] py-1.5 border-b border-[#222]"
                  >
                    <span className="text-accent">{ip}</span>
                    <span className="text-text-secondary text-[10px]">在线</span>
                  </motion.div>
                ))}
              </AnimatePresence>
              {liveIps.length === 0 && !isScanning && (
                <div className="py-20 flex flex-col items-center justify-center opacity-20">
                  <Activity className="w-8 h-8 mb-2" />
                  <p className="text-[10px] uppercase font-bold tracking-widest">未探测到活跃节点</p>
                </div>
              )}
            </div>
          </div>

          <div className="p-4 border-t border-border">
            <button 
              onClick={downloadResults}
              disabled={liveIps.length === 0}
              className="w-full text-[10px] font-bold border border-border py-2 text-text-secondary hover:text-white hover:border-zinc-500 transition-all uppercase disabled:opacity-20"
            >
              导出结果报告 (.txt)
            </button>
          </div>
        </aside>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #333;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #444;
        }
      `}} />
    </div>
  );
}

