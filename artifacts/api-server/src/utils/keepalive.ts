/**
 * Keep-Alive subsystem
 *
 * Free hosting platforms (Render, Railway, Fly.io free tier) spin a service
 * down after ~15 minutes of inactivity.  This module solves that by:
 *   1. Self-pinging the app's own /api/healthz endpoint every 14 minutes
 *   2. Optionally pinging an external uptime-monitor URL (e.g. UptimeRobot)
 *   3. Logging outcomes and back-off retrying on failure
 *
 * Enabled by default in production.  Set KEEP_ALIVE=false to disable.
 * Set KEEP_ALIVE_URL to the app's public base URL on the hosting platform.
 */

import { logger } from "../lib/logger.js";

const PING_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes
const RETRY_DELAY_MS   =      30 * 1000; // retry after 30 s on failure
const MAX_RETRIES       = 3;

interface KeepaliveOptions {
  /** The app's own public base URL, e.g. https://my-bot.onrender.com */
  selfUrl?: string;
  /** Optional external uptime-monitor webhook (UptimeRobot, Better Uptime, etc.) */
  externalUrl?: string;
  /** Override the ping interval in ms (default: 14 min) */
  intervalMs?: number;
}

let pingTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;

async function pingUrl(url: string, label: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "CraftBot-KeepAlive/1.0" },
    });
    clearTimeout(timeout);

    if (res.ok) {
      logger.debug({ label, status: res.status }, "Keep-alive ping OK");
      return true;
    } else {
      logger.warn({ label, status: res.status }, "Keep-alive ping returned non-2xx");
      return false;
    }
  } catch (err) {
    logger.warn({ label, err: err instanceof Error ? err.message : String(err) }, "Keep-alive ping failed");
    return false;
  }
}

async function doPing(opts: Required<KeepaliveOptions>) {
  const selfOk = await pingUrl(`${opts.selfUrl}/api/healthz`, "self");

  if (!selfOk) {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_RETRIES) {
      logger.error({ consecutiveFailures }, "Keep-alive: too many self-ping failures — service may be degraded");
    } else {
      // Retry once after a short delay
      setTimeout(() => pingUrl(`${opts.selfUrl}/api/healthz`, "self-retry"), RETRY_DELAY_MS);
    }
  } else {
    consecutiveFailures = 0;
  }

  if (opts.externalUrl) {
    await pingUrl(opts.externalUrl, "external");
  }
}

export function startKeepalive(opts: KeepaliveOptions = {}) {
  const enabled = process.env["KEEP_ALIVE"] !== "false";
  if (!enabled) {
    logger.info("Keep-alive disabled (KEEP_ALIVE=false)");
    return;
  }
  if (process.env["NODE_ENV"] !== "production") {
    logger.debug("Keep-alive skipped in non-production environment");
    return;
  }

  const selfUrl = opts.selfUrl
    ?? process.env["KEEP_ALIVE_URL"]
    ?? process.env["RENDER_EXTERNAL_URL"]
    ?? process.env["RAILWAY_PUBLIC_DOMAIN"]
    ?? "";

  if (!selfUrl) {
    logger.warn("Keep-alive: no self URL detected (set KEEP_ALIVE_URL env var) — skipping");
    return;
  }

  const externalUrl = opts.externalUrl ?? process.env["KEEP_ALIVE_EXTERNAL_URL"] ?? "";
  const intervalMs  = opts.intervalMs  ?? PING_INTERVAL_MS;

  const resolved: Required<KeepaliveOptions> = {
    selfUrl:     selfUrl.replace(/\/$/, ""),
    externalUrl: externalUrl.replace(/\/$/, ""),
    intervalMs,
  };

  logger.info({ selfUrl: resolved.selfUrl, intervalMs, externalUrl: resolved.externalUrl || "(none)" },
    "Keep-alive started");

  // First ping after 2 min (give server time to boot fully)
  const boot = setTimeout(() => doPing(resolved), 2 * 60 * 1000);
  boot.unref();

  pingTimer = setInterval(() => doPing(resolved), intervalMs);
  pingTimer.unref(); // don't block process exit

  return pingTimer;
}

export function stopKeepalive() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
    logger.info("Keep-alive stopped");
  }
}

export function getKeepaliveStatus() {
  return {
    active:             pingTimer !== null,
    consecutiveFailures,
    intervalMs:         PING_INTERVAL_MS,
    selfUrl:            process.env["KEEP_ALIVE_URL"] ?? process.env["RENDER_EXTERNAL_URL"] ?? "",
  };
}
