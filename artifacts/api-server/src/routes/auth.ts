import { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { UserRepo, PasswordResetRepo } from "../database/Database.js";
import { signToken, COOKIE_NAME, COOKIE_OPTS } from "../lib/auth.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { checkLock, recordFailure, clearAttempts, getClientIp } from "../lib/bruteForce.js";
import { sendPasswordResetEmail } from "../lib/email.js";

const router = Router();

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

router.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body as Record<string, string>;

    if (!username?.trim() || !email?.trim() || !password) {
      res.status(400).json({ error: "Username, email and password are required" });
      return;
    }
    if (username.trim().length < 3) {
      res.status(400).json({ error: "Username must be at least 3 characters" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email.trim())) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }

    if (await UserRepo.getByEmail(email.trim().toLowerCase())) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    if (await UserRepo.getByUsername(username.trim())) {
      res.status(409).json({ error: "Username already taken" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await UserRepo.create({
      username: username.trim(),
      email: email.trim().toLowerCase(),
      passwordHash,
    });

    const token = signToken({ userId: user.id, username: user.username, email: user.email, tier: user.tier });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, tier: user.tier } });
  } catch {
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

router.post("/login", async (req, res) => {
  const ip = getClientIp(req);

  const lock = checkLock(ip, "user");
  if (lock.locked) {
    const mins = Math.ceil((lock.retryAfterSec ?? 0) / 60);
    res.status(429).json({ error: `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? "s" : ""}.`, locked: true });
    return;
  }

  try {
    const { email, password } = req.body as Record<string, string>;

    if (!email?.trim() || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const user = await UserRepo.getByEmail(email.trim().toLowerCase());
    if (!user) {
      const r = recordFailure(ip, "user");
      const msg = r.locked
        ? `Too many failed attempts. Try again in ${Math.ceil((r.retryAfterSec ?? 0) / 60)} minutes.`
        : `Invalid email or password. ${r.remaining} attempt${r.remaining !== 1 ? "s" : ""} remaining.`;
      res.status(401).json({ error: msg, remaining: r.remaining, locked: r.locked });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const r = recordFailure(ip, "user");
      const msg = r.locked
        ? `Too many failed attempts. Try again in ${Math.ceil((r.retryAfterSec ?? 0) / 60)} minutes.`
        : `Invalid email or password. ${r.remaining} attempt${r.remaining !== 1 ? "s" : ""} remaining.`;
      res.status(401).json({ error: msg, remaining: r.remaining, locked: r.locked });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({ error: "This account has been suspended" });
      return;
    }

    clearAttempts(ip, "user");

    const token = signToken({ userId: user.id, username: user.username, email: user.email, tier: user.tier });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, tier: user.tier } });
  } catch {
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

router.get("/me", requireAuth, async (req, res) => {
  const fresh = await UserRepo.getById(req.user!.userId);
  if (!fresh) { res.status(404).json({ error: "User not found" }); return; }
  res.json({
    user: {
      id: fresh.id,
      username: fresh.username,
      email: fresh.email,
      tier: fresh.tier,
      created_at: fresh.created_at,
    },
  });
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body as Record<string, string>;
  if (!email?.trim()) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const genericOk = { success: true, message: "If that email is registered, a reset code has been sent." };

  try {
    const user = await UserRepo.getByEmail(email.trim().toLowerCase());
    if (!user) { res.json(genericOk); return; }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await PasswordResetRepo.create(user.id, hashOtp(otp));
    await sendPasswordResetEmail(user.email, user.username, otp);

    res.json(genericOk);
  } catch {
    res.status(500).json({ error: "Failed to send reset email. Please try again." });
  }
});

router.post("/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body as Record<string, string>;

  if (!email?.trim() || !otp?.trim() || !newPassword) {
    res.status(400).json({ error: "Email, code, and new password are required" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters" });
    return;
  }

  try {
    const user = await UserRepo.getByEmail(email.trim().toLowerCase());
    if (!user) {
      res.status(400).json({ error: "Invalid or expired reset code" });
      return;
    }

    const tokenHash = hashOtp(otp.trim());
    const record = await PasswordResetRepo.findValid(user.id, tokenHash);
    if (!record) {
      res.status(400).json({ error: "Invalid or expired reset code. Please request a new one." });
      return;
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await UserRepo.resetPassword(user.id, hash);
    await PasswordResetRepo.markUsed(record.id);
    clearAttempts(email.trim().toLowerCase(), "user");

    res.json({ success: true, message: "Password reset successfully. You can now sign in." });
  } catch {
    res.status(500).json({ error: "Failed to reset password. Please try again." });
  }
});

export default router;
