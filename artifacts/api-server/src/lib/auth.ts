import jwt from "jsonwebtoken";

const JWT_SECRET = process.env["JWT_SECRET"] || "mcbot_jwt_secret_CHANGE_IN_PRODUCTION_please";
const JWT_EXPIRES = "7d";

export interface JwtPayload {
  userId: number;
  username: string;
  email: string;
  tier: string;
  iat?: number;
  exp?: number;
}

export function signToken(payload: Omit<JwtPayload, "iat" | "exp">): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

export const COOKIE_NAME = "mcbot_token";
export const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  secure: process.env["NODE_ENV"] === "production",
};
