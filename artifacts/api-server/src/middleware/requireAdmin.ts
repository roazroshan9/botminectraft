import type { Request, Response, NextFunction } from "express";

const ADMIN_PASSWORD = process.env["DASHBOARD_PASSWORD"] || "admin";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const pass =
    (req.headers["x-admin-password"] as string | undefined) ||
    (req.body as Record<string, unknown>)?.["adminPassword"] as string | undefined;

  if (!pass || pass !== ADMIN_PASSWORD) {
    res.status(403).json({ error: "Admin access denied" });
    return;
  }
  next();
}
