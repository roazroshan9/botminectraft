import type { Request, Response, NextFunction } from "express";
import { checkLock, recordFailure, clearAttempts, getClientIp } from "../lib/bruteForce.js";

const ADMIN_PASSWORD = process.env["DASHBOARD_PASSWORD"] || "admin";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ip = getClientIp(req as Parameters<typeof getClientIp>[0]);

  const lock = checkLock(ip, "admin");
  if (lock.locked) {
    const mins = Math.ceil((lock.retryAfterSec ?? 0) / 60);
    res.status(429).json({ error: `Admin access locked. Try again in ${mins} minute${mins !== 1 ? "s" : ""}.` });
    return;
  }

  const pass =
    (req.headers["x-admin-password"] as string | undefined) ||
    ((req.body as Record<string, unknown>)?.["adminPassword"] as string | undefined);

  if (!pass || pass !== ADMIN_PASSWORD) {
    recordFailure(ip, "admin");
    res.status(403).json({ error: "Admin access denied" });
    return;
  }

  clearAttempts(ip, "admin");
  next();
}
