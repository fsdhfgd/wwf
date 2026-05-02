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

    const sendEvent = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const cleanCidr = (cidr || "").trim();
      if (!cleanCidr.includes("/")) {
        sendEvent({ type: "error", message: "格式错误: 必须包含子网掩码 (例如 /24)" });
        res.end();
        return;
      }

      const [addrPart, maskPart] = cleanCidr.split("/");
      const mask = parseInt(maskPart);
      
      if (isNaN(mask) || mask < 0 || mask > 32) {
        sendEvent({ type: "error", message: "掩码无效: 必须在 0-32 之间" });
        res.end();
        return;
      }

      let networkAddr;
      try {
        networkAddr = ipaddr.parse(addrPart);
      } catch (e) {
        sendEvent({ type: "error", message: "IP 地址格式不正确" });
        res.end();
        return;
      }

      if (networkAddr.kind() !== 'ipv4') {
        sendEvent({ type: "error", message: "目前仅支持 IPv4 扫描" });
        res.end();
        return;
      }

      const ipv4Addr = networkAddr as ipaddr.IPv4;
      const numHosts = Math.pow(2, 32 - mask);
      
      // Calculate start address based on mask
      const ipBytes = ipv4Addr.toByteArray();
      let ipLong = ((ipBytes[0] << 24) >>> 0) + (ipBytes[1] << 16) + (ipBytes[2] << 8) + ipBytes[3];
      
      // Apply mask to get network start
      const maskLong = (0xFFFFFFFF << (32 - mask)) >>> 0;
      const startLong = (ipLong & maskLong) >>> 0;

      sendEvent({ type: "start", total: numHosts });

      const longToIp = (long: number) => {
        return [
          (long >>> 24) & 0xFF,
          (long >>> 16) & 0xFF,
          (long >>> 8) & 0xFF,
          long & 0xFF
        ].join(".");
      };

      let scanned = 0;
      let liveCount = 0;
      let isAborted = false;

      req.on("close", () => {
        isAborted = true;
      });

      const pingIp = (ip: string) => {
        return new Promise<boolean>((resolve) => {
          if (isAborted) return resolve(false);
          const p = spawn("ping", ["-c", "1", "-W", timeout.toString(), ip]);
          p.on("close", (code) => resolve(code === 0));
          setTimeout(() => {
            if (p.exitCode === null) p.kill();
            resolve(false);
          }, (timeout + 1) * 1000);
        });
      };

      // Concurrent Scanning
      const CONCURRENCY = 150; 
      const startScanning = async () => {
        for (let i = 0; i < numHosts; i += CONCURRENCY) {
          if (isAborted) break;
          
          const batchSize = Math.min(CONCURRENCY, numHosts - i);
          const batch = Array.from({ length: batchSize }, (_, index) => longToIp(startLong + i + index));
          
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
