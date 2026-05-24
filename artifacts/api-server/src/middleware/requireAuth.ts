import type { Request, Response, NextFunction } from "express";
import { verifyToken, COOKIE_NAME, type JwtPayload } from "../lib/auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const cookie = (req.cookies as Record<string, string>)?.[COOKIE_NAME];
  const header = req.headers.authorization?.replace("Bearer ", "").trim();
  const token = cookie || header;

  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired session" });
    return;
  }

  req.user = payload;
  next();
}
