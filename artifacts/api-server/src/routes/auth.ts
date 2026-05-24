import { Router } from "express";
import bcrypt from "bcryptjs";
import { UserRepo } from "../database/Database.js";
import { signToken, COOKIE_NAME, COOKIE_OPTS } from "../lib/auth.js";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();

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

    if (UserRepo.getByEmail(email.trim().toLowerCase())) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    if (UserRepo.getByUsername(username.trim())) {
      res.status(409).json({ error: "Username already taken" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = UserRepo.create({
      username: username.trim(),
      email: email.trim().toLowerCase(),
      passwordHash,
    });

    const token = signToken({ userId: user.id, username: user.username, email: user.email, tier: user.tier });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, tier: user.tier } });
  } catch (err) {
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body as Record<string, string>;

    if (!email?.trim() || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const user = UserRepo.getByEmail(email.trim().toLowerCase());
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash as string);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({ error: "This account has been suspended" });
      return;
    }

    const token = signToken({
      userId: user.id as number,
      username: user.username as string,
      email: user.email as string,
      tier: user.tier as string,
    });
    res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
    res.json({ success: true, token, user: { id: user.id, username: user.username, email: user.email, tier: user.tier } });
  } catch (err) {
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

router.post("/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ success: true });
});

router.get("/me", requireAuth, (req, res) => {
  const fresh = UserRepo.getById(req.user!.userId);
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

export default router;
