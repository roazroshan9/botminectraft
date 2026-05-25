import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getMemoryStats } from "../utils/memory.js";
import { getKeepaliveStatus } from "../utils/keepalive.js";
import { BotManager } from "../bot/BotManager.js";

const router: IRouter = Router();

function buildHealthPayload(detailed: boolean) {
  const base = HealthCheckResponse.parse({ status: "ok" });
  if (!detailed) return base;

  const manager = BotManager.getInstance();
  const bots     = manager.getAllBots();
  const online   = bots.filter(b => b.getStatus() === "connected").length;

  return {
    ...base,
    version:   process.env["npm_package_version"] ?? "unknown",
    env:       process.env["NODE_ENV"] ?? "development",
    uptime:    Math.round(process.uptime()),
    memory:    getMemoryStats(),
    keepalive: getKeepaliveStatus(),
    bots: {
      total:  bots.length,
      online,
    },
  };
}

// Primary health endpoint (used by Render, Docker HEALTHCHECK, monitoring)
router.get("/healthz", (_req, res) => {
  res.json(buildHealthPayload(false));
});

// Alias — some platforms / docs reference /health (without the z)
router.get("/health", (_req, res) => {
  res.json(buildHealthPayload(false));
});

// Detailed readiness probe — includes memory, bots, keep-alive status
router.get("/readyz", (_req, res) => {
  res.json(buildHealthPayload(true));
});

export default router;
