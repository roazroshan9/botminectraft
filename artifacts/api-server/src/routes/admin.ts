import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { UserRepo, UserBotRepo, SupportRepo, PaymentRepo, LiveLogRepo } from "../database/Database.js";
import { BotManager } from "../bot/BotManager.js";
import { io } from "../app.js";

const router = Router();
router.use(requireAdmin);

// ─── Users ───────────────────────────────────────────────────────────────────

router.get("/users", (_req, res) => {
  const users = UserRepo.getAll();
  const enriched = users.map(u => ({
    ...u,
    botCount: UserBotRepo.countByUser(u.id),
  }));
  res.json({ users: enriched, total: enriched.length });
});

router.put("/users/:id/tier", (req, res) => {
  const id = parseInt(req.params["id"]!, 10);
  const { tier } = req.body as { tier: string };
  const valid = ["free", "premium", "enterprise"];
  if (!valid.includes(tier)) { res.status(400).json({ error: `tier must be one of: ${valid.join(", ")}` }); return; }
  const user = UserRepo.getById(id);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  UserRepo.setTier(id, tier);
  res.json({ success: true, userId: id, tier });
});

router.put("/users/:id/active", (req, res) => {
  const id = parseInt(req.params["id"]!, 10);
  const { active } = req.body as { active: boolean };
  const user = UserRepo.getById(id);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  UserRepo.setActive(id, active);
  res.json({ success: true, userId: id, active });
});

router.get("/users/:id/bots", (req, res) => {
  const id = parseInt(req.params["id"]!, 10);
  const bots = UserBotRepo.getByUser(id);
  const manager = BotManager.getInstance();
  const enriched = bots.map(b => {
    const runtimeId = b.runtime_id;
    const runtime = runtimeId ? manager.getBot(runtimeId) : undefined;
    return { ...b, runtimeStats: runtime ? runtime.getStats() : null };
  });
  res.json({ bots: enriched });
});

// ─── Support Hub ─────────────────────────────────────────────────────────────

router.get("/support", (_req, res) => {
  const all = SupportRepo.getAllThreads();
  // Group by user, latest message first per user
  const byUser: Record<number, { userId: number; username: string; unreadCount: number; lastMessage: string; lastTime: string; messages: typeof all }> = {};
  for (const msg of all) {
    if (!byUser[msg.user_id]) {
      byUser[msg.user_id] = {
        userId: msg.user_id,
        username: (msg as unknown as Record<string, string>)["username"] || "Unknown",
        unreadCount: 0,
        lastMessage: msg.message,
        lastTime: msg.timestamp,
        messages: [],
      };
    }
    byUser[msg.user_id]!.messages.push(msg);
    if (msg.sender === "user" && !msg.is_read) byUser[msg.user_id]!.unreadCount++;
  }
  const threads = Object.values(byUser).sort((a, b) =>
    new Date(b.lastTime).getTime() - new Date(a.lastTime).getTime()
  );
  const unreadTotal = SupportRepo.getUnreadCount();
  res.json({ threads, unreadTotal });
});

router.get("/support/:userId", (req, res) => {
  const userId = parseInt(req.params["userId"]!, 10);
  const user = UserRepo.getById(userId);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const messages = SupportRepo.getThreadsByUser(userId);
  SupportRepo.markRead(userId);
  io.to(`user:${userId}`).emit("support:read");
  res.json({ messages, user: { id: user.id, username: user.username, email: user.email, tier: user.tier } });
});

router.post("/support/:userId/reply", (req, res) => {
  const userId = parseInt(req.params["userId"]!, 10);
  const { message } = req.body as { message: string };
  if (!message?.trim()) { res.status(400).json({ error: "message is required" }); return; }
  const user = UserRepo.getById(userId);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const msg = SupportRepo.insert(userId, message.trim(), "admin");
  io.to(`user:${userId}`).emit("support:message", { ...msg, fromAdmin: true });
  res.json({ message: msg });
});

router.post("/support/:userId/read", (req, res) => {
  const userId = parseInt(req.params["userId"]!, 10);
  SupportRepo.markRead(userId);
  res.json({ success: true });
});

// ─── Stats / Overview ─────────────────────────────────────────────────────────

router.get("/stats", (_req, res) => {
  const manager = BotManager.getInstance();
  const allBots = manager.getAllStats();
  const users = UserRepo.getAll();
  res.json({
    totalUsers: users.length,
    totalBots: allBots.length,
    onlineBots: allBots.filter(b => b.status === "connected").length,
    unreadSupport: SupportRepo.getUnreadCount(),
    usersByTier: {
      free: users.filter(u => u.tier === "free").length,
      premium: users.filter(u => u.tier === "premium").length,
      enterprise: users.filter(u => u.tier === "enterprise").length,
    },
  });
});

export default router;
