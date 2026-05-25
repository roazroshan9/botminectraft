import { Router } from "express";
import bcrypt from "bcryptjs";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { UserRepo, UserBotRepo, SupportRepo, PaymentRepo } from "../database/Database.js";
import { BotManager } from "../bot/BotManager.js";
import { io } from "../app.js";

const router = Router();
router.use(requireAdmin);

// ─── Stats / Overview ────────────────────────────────────────────────────────

router.get("/stats", async (_req, res) => {
  try {
    const manager = BotManager.getInstance();
    const allBots = manager.getAllStats();
    const [users, revenue, mrr, recentPayments, recentUsers, unreadSupport] = await Promise.all([
      UserRepo.getAll(),
      PaymentRepo.getRevenue(),
      PaymentRepo.getMrr(),
      PaymentRepo.getRecentWithUser(8),
      UserRepo.getRecent(8),
      SupportRepo.getUnreadCount(),
    ]);

    res.json({
      totalUsers: users.length,
      totalBots: allBots.length,
      onlineBots: allBots.filter(b => b.status === "connected").length,
      unreadSupport,
      usersByTier: {
        free:       users.filter(u => u.tier === "free").length,
        premium:    users.filter(u => u.tier === "premium").length,
        enterprise: users.filter(u => u.tier === "enterprise").length,
      },
      revenue: { total: revenue, mrr },
      recentPayments,
      recentUsers,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load stats" });
  }
});

// ─── Users ───────────────────────────────────────────────────────────────────

router.get("/users", async (_req, res) => {
  try {
    const users = await UserRepo.getAll();
    const enriched = await Promise.all(users.map(async u => ({
      ...u,
      botCount: await UserBotRepo.countByUser(u.id),
      payments: await PaymentRepo.getByUser(u.id),
    })));
    res.json({ users: enriched, total: enriched.length });
  } catch {
    res.status(500).json({ error: "Failed to load users" });
  }
});

router.put("/users/:id/tier", async (req, res) => {
  const id = parseInt(req.params["id"]!, 10);
  const { tier } = req.body as { tier: string };
  const valid = ["free", "premium", "enterprise"];
  if (!valid.includes(tier)) { res.status(400).json({ error: `tier must be one of: ${valid.join(", ")}` }); return; }
  const user = await UserRepo.getById(id);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  await UserRepo.setTier(id, tier);
  io.to(`user:${user.id}`).emit("account:tier_changed", { tier });
  res.json({ success: true, userId: id, tier });
});

router.put("/users/:id/active", async (req, res) => {
  const id = parseInt(req.params["id"]!, 10);
  const { active } = req.body as { active: boolean };
  const user = await UserRepo.getById(id);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  await UserRepo.setActive(id, active);
  res.json({ success: true, userId: id, active });
});

router.get("/users/:id/bots", async (req, res) => {
  const id = parseInt(req.params["id"]!, 10);
  const bots = await UserBotRepo.getByUser(id);
  const manager = BotManager.getInstance();
  const enriched = bots.map(b => {
    const runtimeId = b.runtime_id;
    const runtime = runtimeId ? manager.getBot(runtimeId) : undefined;
    return { ...b, runtimeStats: runtime ? runtime.getStats() : null };
  });
  res.json({ bots: enriched });
});

// ─── Support Hub ─────────────────────────────────────────────────────────────

router.get("/support", async (_req, res) => {
  try {
    const all = await SupportRepo.getAllThreads();
    const unreadTotal = await SupportRepo.getUnreadCount();

    const byUser: Record<number, {
      userId: number; username: string; unreadCount: number;
      lastMessage: string; lastTime: string | Date;
      messages: typeof all;
    }> = {};

    for (const msg of all) {
      if (!byUser[msg.user_id]) {
        byUser[msg.user_id] = {
          userId: msg.user_id,
          username: msg.username || "Unknown",
          unreadCount: 0,
          lastMessage: msg.message,
          lastTime: msg.timestamp,
          messages: [],
        };
      }
      byUser[msg.user_id]!.messages.push(msg);
      if (msg.sender === "user" && !msg.is_read) byUser[msg.user_id]!.unreadCount++;
    }

    const threads = Object.values(byUser).sort(
      (a, b) => new Date(b.lastTime as string).getTime() - new Date(a.lastTime as string).getTime()
    );
    res.json({ threads, unreadTotal });
  } catch {
    res.status(500).json({ error: "Failed to load support threads" });
  }
});

router.get("/support/:userId", async (req, res) => {
  const userId = parseInt(req.params["userId"]!, 10);
  const user = await UserRepo.getById(userId);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const messages = await SupportRepo.getThreadsByUser(userId);
  await SupportRepo.markRead(userId);
  io.to(`user:${userId}`).emit("support:read");
  res.json({
    messages,
    user: { id: user.id, username: user.username, email: user.email, tier: user.tier },
  });
});

router.post("/support/:userId/reply", async (req, res) => {
  const userId = parseInt(req.params["userId"]!, 10);
  const { message } = req.body as { message: string };
  if (!message?.trim()) { res.status(400).json({ error: "message is required" }); return; }
  const user = await UserRepo.getById(userId);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const msg = await SupportRepo.insert(userId, message.trim(), "admin");
  io.to(`user:${userId}`).emit("support:message", { ...msg, fromAdmin: true });
  io.emit("support:admin_reply", { userId, username: user.username, message: msg });
  res.json({ message: msg });
});

router.post("/support/:userId/read", async (req, res) => {
  const userId = parseInt(req.params["userId"]!, 10);
  await SupportRepo.markRead(userId);
  res.json({ success: true });
});

// ─── Seed ─────────────────────────────────────────────────────────────────────
// POST /api/admin/seed
// Creates the initial admin user if one doesn't already exist.
// Protected by requireAdmin (x-admin-password header or adminPassword body field).
// Rate-limited: 1 call per IP per hour to prevent abuse in production.
//
// Body (optional — overrides defaults):
//   { "username": "admin", "email": "you@example.com", "password": "s3cur3!" }

const SEED_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 hour
const seedLastCalledAt = new Map<string, number>();

router.post("/seed", async (req, res) => {
  const ip = req.ip ?? "unknown";
  const last = seedLastCalledAt.get(ip) ?? 0;
  const elapsed = Date.now() - last;

  if (elapsed < SEED_RATE_LIMIT_MS) {
    const retryAfterSec = Math.ceil((SEED_RATE_LIMIT_MS - elapsed) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "Rate limit exceeded. The seed endpoint may only be called once per hour per IP.",
      retryAfterSeconds: retryAfterSec,
    });
    return;
  }
  seedLastCalledAt.set(ip, Date.now());
  try {
    const {
      username = "admin",
      email    = process.env["ADMIN_EMAIL"] ?? "admin@example.com",
      password = "McBot@Admin2026!",
    } = (req.body ?? {}) as { username?: string; email?: string; password?: string };

    if (!email?.trim()) {
      res.status(400).json({ error: "email is required" });
      return;
    }
    if (!password || password.length < 8) {
      res.status(400).json({ error: "password must be at least 8 characters" });
      return;
    }

    const existing = await UserRepo.getByEmail(email.trim().toLowerCase());
    if (existing) {
      res.json({
        success: true,
        skipped: true,
        message: `User with email "${existing.email}" already exists (id=${existing.id}). Nothing created.`,
        user: { id: existing.id, username: existing.username, email: existing.email, tier: existing.tier },
      });
      return;
    }

    if (await UserRepo.getByUsername(username.trim())) {
      res.status(409).json({ error: `Username "${username.trim()}" is already taken. Pass a different username in the request body.` });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await UserRepo.create({
      username: username.trim(),
      email: email.trim().toLowerCase(),
      passwordHash,
    });

    await UserRepo.setTier(user.id, "admin");

    res.status(201).json({
      success: true,
      skipped: false,
      message: "Admin user created successfully.",
      user: { id: user.id, username: user.username, email: user.email, tier: "admin" },
    });
  } catch (err) {
    res.status(500).json({ error: "Seed failed. Check server logs for details." });
  }
});

export default router;
