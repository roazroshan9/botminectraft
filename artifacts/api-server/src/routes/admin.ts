import { Router } from "express";
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

export default router;
