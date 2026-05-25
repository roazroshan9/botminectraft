import type { Request, Response, NextFunction } from "express";
import { getTier } from "../config/tiers.js";
import { UserBotRepo } from "../database/Database.js";

export function tierGuard(feature: "microsoftAuth" | "liveSupport") {
  return (req: Request, res: Response, next: NextFunction): void => {
    const tier = req.user?.tier ?? "free";
    const cfg = getTier(tier);

    if (!cfg[feature]) {
      res.status(403).json({
        error: `Your ${tier} plan does not include this feature`,
        feature,
        upgrade: "premium",
        current: tier,
      });
      return;
    }
    next();
  };
}

export function botSlotGuard(req: Request, res: Response, next: NextFunction): void {
  const userId = req.user?.userId;
  if (!userId) { res.status(401).json({ error: "Not authenticated" }); return; }

  const tier = req.user?.tier ?? "free";
  const cfg = getTier(tier);

  UserBotRepo.countByUser(userId).then(count => {
    if (count >= cfg.botSlots) {
      res.status(403).json({
        error: `Bot slot limit reached (${cfg.botSlots} on ${tier} plan)`,
        limit: cfg.botSlots,
        current: count,
        upgrade: tier === "free" ? "premium" : "enterprise",
      });
      return;
    }
    next();
  }).catch(() => {
    res.status(500).json({ error: "Failed to check bot slot limit" });
  });
}
