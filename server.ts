import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import cors from "cors";
import { spawn } from "child_process";
import ipaddr from "ipaddr.js";

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());

  // SSE Scanning Endpoint
  app.get("/api/scan", (req, res) => {
    const cidr = req.query.cidr as string;
    const timeout = parseInt(req.query.timeout as string || "1");
    
    if (!cidr) {
      res.status(400).send("CIDR is required");
      return;
    }

    // Set headers for SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // CRITICAL: Stop proxy buffering

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const cleanCidr = (cidr || "").replace(/\s/g, "");
      if (!cleanCidr.includes("/")) {
        sendEvent({ type: "error", message: "格式错误: 必须包含子网掩码 (例如 /24)" });
        res.end();
        return;
      }

      const [addrPart, maskPart] = cleanCidr.split("/");
      const mask = parseInt(maskPart);
      
      let networkAddr: ipaddr.IPv4 | ipaddr.IPv6;
      try {
        networkAddr = ipaddr.parse(addrPart) as ipaddr.IPv4 | ipaddr.IPv6;
      } catch (e) {
        sendEvent({ type: "error", message: "IP 地址或格式不正确" });
        res.end();
        return;
      }

      const isIPv6 = networkAddr.kind() === 'ipv6';
      const maxMask = isIPv6 ? 128 : 32;

      if (isNaN(mask) || mask < 0 || mask > maxMask) {
        sendEvent({ type: "error", message: `掩码无效: IPv${isIPv6 ? '6' : '4'} 必须在 0-${maxMask} 之间` });
        res.end();
        return;
      }

      const totalHosts = isIPv6 ? (1n << BigInt(128 - mask)) : (1n << BigInt(32 - mask));
      const maxScanLimit = 1024n;
      const scanCount = totalHosts > maxScanLimit ? maxScanLimit : totalHosts;
      const numHosts = Number(scanCount);

      const ipBytes = networkAddr.toByteArray();
      
      // Calculate start address based on mask
      const getStartAddr = () => {
        if (!isIPv6) {
          const ipLong = ((ipBytes[0] << 24) >>> 0) + (ipBytes[1] << 16) + (ipBytes[2] << 8) + ipBytes[3];
          const maskLong = mask === 0 ? 0 : (0xFFFFFFFF << (32 - mask)) >>> 0;
          return BigInt((ipLong & maskLong) >>> 0);
        } else {
          let ipBig = 0n;
          for (const byte of ipBytes) ipBig = (ipBig << 8n) | BigInt(byte);
          const fullMask = (1n << 128n) - 1n;
          const maskBig = (fullMask << BigInt(128 - mask)) & fullMask;
          return ipBig & maskBig;
        }
      };

      const startLong = getStartAddr();

      sendEvent({ type: "start", total: numHosts });

      if (totalHosts > maxScanLimit) {
        sendEvent({ 
          type: "info", 
          message: `网段容量为 ${totalHosts.toString()} 个地址，为保障性能与系统稳定，已自动优化为扫描前 ${maxScanLimit.toString()} 个地址` 
        });
      }

      const longToIp = (long: bigint) => {
        if (!isIPv6) {
          const n = Number(long);
          return [
            (n >>> 24) & 0xFF,
            (n >>> 16) & 0xFF,
            (n >>> 8) & 0xFF,
            n & 0xFF
          ].join(".");
        } else {
          const bytes = [];
          let temp = long;
          for (let i = 0; i < 16; i++) {
            bytes.unshift(Number(temp & 0xFFn));
            temp >>= 8n;
          }
          return ipaddr.fromByteArray(bytes).toString();
        }
      };

      let scanned = 0;
      let liveCount = 0;
      let isAborted = false;

      req.on("close", () => {
        isAborted = true;
      });

      // Detect OS for ping parameters
      const isWin = process.platform === "win32";
      const pingParams = isWin ? ["-n", "1", "-w"] : ["-c", "1", "-W"];

      const pingIp = (ip: string) => {
        return new Promise<boolean>((resolve) => {
          if (isAborted) return resolve(false);
          const timeoutStr = isWin ? (timeout * 1000).toString() : timeout.toString();
          const p = spawn("ping", [...pingParams, timeoutStr, ip]);
          
          let resolved = false;
          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              try {
                if (p.exitCode === null) p.kill("SIGKILL");
              } catch (e) {}
              resolve(false);
            }
          }, (timeout + 1) * 1000);

          p.on("close", (code) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve(code === 0);
            }
          });

          p.on("error", () => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve(false);
            }
          });
        });
      };

      // Faster concurrency for high-density design demo
      const CONCURRENCY = 64; 
      const startScanning = async () => {
        for (let i = 0; i < numHosts; i += CONCURRENCY) {
          if (isAborted) break;
          
          const batchSize = Math.min(CONCURRENCY, numHosts - i);
          const batch = Array.from({ length: batchSize }, (_, index) => longToIp(startLong + BigInt(i + index)));
          
          await Promise.all(batch.map(async (ip) => {
            const isAlive = await pingIp(ip);
            if (isAlive) {
              liveCount++;
              sendEvent({ type: "live", ip });
            }
          }));

          scanned += batchSize;
          sendEvent({ type: "progress", scanned, total: numHosts, liveCount });
        }
        
        if (!isAborted) {
          sendEvent({ type: "end", scanned, liveCount });
          res.end();
        }
      };

      startScanning();

    } catch (error: any) {
      sendEvent({ type: "error", message: error.message });
      res.end();
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
