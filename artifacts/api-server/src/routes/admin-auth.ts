import { Router } from "express";
import { checkLock, recordFailure, clearAttempts, getClientIp } from "../lib/bruteForce.js";

const ADMIN_PASSWORD = process.env["DASHBOARD_PASSWORD"] || "admin";

const router = Router();

router.post("/login", (req, res) => {
  const ip = getClientIp(req);
  const { password } = req.body as Record<string, string>;

  const lock = checkLock(ip, "admin");
  if (lock.locked) {
    const mins = Math.ceil((lock.retryAfterSec ?? 0) / 60);
    res.status(429).json({
      error: `Too many failed attempts. Admin access locked for ${mins} more minute${mins !== 1 ? "s" : ""}.`,
      locked: true,
      retryAfterSec: lock.retryAfterSec,
    });
    return;
  }

  if (!password || password !== ADMIN_PASSWORD) {
    const r = recordFailure(ip, "admin");
    if (r.locked) {
      const mins = Math.ceil((r.retryAfterSec ?? 0) / 60);
      res.status(429).json({
        error: `Too many failed attempts. Admin access locked for ${mins} minute${mins !== 1 ? "s" : ""}.`,
        locked: true,
        retryAfterSec: r.retryAfterSec,
      });
    } else {
      res.status(403).json({
        error: `Incorrect password. ${r.remaining} attempt${r.remaining !== 1 ? "s" : ""} remaining before lockout.`,
        remaining: r.remaining,
      });
    }
    return;
  }

  clearAttempts(ip, "admin");
  res.json({ success: true });
});

export default router;
