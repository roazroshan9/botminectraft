import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { UserBotRepo, LiveLogRepo } from "../database/Database.js";
import { BotManager } from "../bot/BotManager.js";
import { getTier } from "../config/tiers.js";
import { parseCommand } from "../commands/CommandParser.js";

const router = Router();

router.use(requireAuth);

router.get("/profile", (req, res) => {
  const user = req.user!;
  const tier = getTier(user.tier);
  const botCount = UserBotRepo.countByUser(user.userId);
  res.json({
    userId: user.userId,
    username: user.username,
    email: user.email,
    tier: user.tier,
    tierInfo: tier,
    botCount,
    botSlotsUsed: botCount,
    botSlotsMax: tier.botSlots,
  });
});

router.get("/bots", (req, res) => {
  const userId = req.user!.userId;
  const dbBots = UserBotRepo.getByUser(userId);
  const manager = BotManager.getInstance();

  const bots = dbBots.map(row => {
    const runtimeId = row.runtime_id ?? manager.getUserBotRuntimeId(row.id);
    const runtime = runtimeId ? manager.getBot(runtimeId) : undefined;
    return {
      id: row.id,
      runtimeId: runtimeId ?? null,
      botName: row.bot_name,
      serverIp: row.server_ip,
      serverPort: row.server_port,
      mcVersion: row.mc_version,
      authType: row.auth_type,
      status: runtime ? runtime.getStatus() : row.status,
      currentTask: runtime ? (runtime.taskQueue.getCurrent()?.name ?? null) : row.current_task,
      stats: runtime ? runtime.getStats() : null,
      createdAt: row.created_at,
    };
  });

  res.json({ bots });
});

router.post("/bots", (req, res) => {
  const user = req.user!;
  const tier = getTier(user.tier);

  const currentCount = UserBotRepo.countByUser(user.userId);
  if (currentCount >= tier.botSlots) {
    res.status(403).json({
      error: `Your ${tier.name} plan allows ${tier.botSlots} bot(s). Upgrade to add more.`,
      upgradeRequired: true,
    });
    return;
  }

  const { botName, serverIp, serverPort, mcVersion, authType } = req.body as {
    botName: string;
    serverIp: string;
    serverPort?: number;
    mcVersion?: string;
    authType?: string;
  };

  if (!botName || !serverIp) {
    res.status(400).json({ error: "botName and serverIp are required" });
    return;
  }

  if (authType === "microsoft" && !tier.microsoftAuth) {
    res.status(403).json({
      error: "Microsoft authentication requires a Premium plan or higher.",
      upgradeRequired: true,
    });
    return;
  }

  const row = UserBotRepo.create({
    userId: user.userId,
    botName,
    serverIp,
    serverPort: serverPort ?? 25565,
    mcVersion: mcVersion ?? "auto",
    authType: authType ?? "offline",
  });

  res.status(201).json({ bot: row, message: "Bot created. Use /connect to start it." });
});

router.post("/bots/:id/connect", (req, res) => {
  const user = req.user!;
  const dbBotId = parseInt(req.params["id"]!, 10);
  const row = UserBotRepo.getById(dbBotId);

  if (!row || row.user_id !== user.userId) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  const manager = BotManager.getInstance();

  if (row.runtime_id && manager.getBot(row.runtime_id)) {
    res.status(400).json({ error: "Bot is already running" });
    return;
  }

  const bot = manager.addUserBot(user.userId, dbBotId, {
    username: row.bot_name,
    host: row.server_ip,
    port: row.server_port,
    version: row.mc_version === "auto" ? "1.20.1" : row.mc_version,
    auth: row.auth_type as "offline" | "microsoft",
  });

  res.json({ runtimeId: bot.id, message: "Bot connecting..." });
});

router.post("/bots/:id/disconnect", (req, res) => {
  const user = req.user!;
  const dbBotId = parseInt(req.params["id"]!, 10);
  const row = UserBotRepo.getById(dbBotId);

  if (!row || row.user_id !== user.userId) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  const manager = BotManager.getInstance();
  const runtimeId = row.runtime_id ?? manager.getUserBotRuntimeId(dbBotId);
  if (runtimeId) {
    const bot = manager.getBot(runtimeId);
    if (bot) bot.disconnect(false);
  }
  UserBotRepo.updateStatus(dbBotId, "offline", null, null);
  res.json({ message: "Bot disconnected" });
});

router.post("/bots/:id/command", async (req, res) => {
  const user = req.user!;
  const dbBotId = parseInt(req.params["id"]!, 10);
  const row = UserBotRepo.getById(dbBotId);

  if (!row || row.user_id !== user.userId) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  const manager = BotManager.getInstance();
  const runtimeId = row.runtime_id ?? manager.getUserBotRuntimeId(dbBotId);
  if (!runtimeId) {
    res.status(400).json({ error: "Bot is not running" });
    return;
  }

  const { command, args, amount, raw } = req.body as {
    command?: string; args?: string[]; amount?: number; raw?: string;
  };

  try {
    let result: string;
    if (raw) {
      const parsed = parseCommand(raw);
      if (!parsed) { res.status(400).json({ error: "Invalid command" }); return; }
      result = await manager.sendCommand(runtimeId, parsed.command, parsed.args, parsed.amount);
    } else if (command) {
      result = await manager.sendCommand(runtimeId, command, args ?? [], amount);
    } else {
      res.status(400).json({ error: "Provide command or raw" });
      return;
    }
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/bots/:id/logs", (req, res) => {
  const user = req.user!;
  const dbBotId = parseInt(req.params["id"]!, 10);
  const row = UserBotRepo.getById(dbBotId);

  if (!row || row.user_id !== user.userId) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  const manager = BotManager.getInstance();
  const runtimeId = row.runtime_id ?? manager.getUserBotRuntimeId(dbBotId);
  const runtimeLogs = runtimeId ? manager.getBot(runtimeId)?.getLogs() ?? [] : [];
  const dbLogs = LiveLogRepo.getByBot(dbBotId, 200).map(l => `[${l.timestamp}] ${l.message}`).reverse();

  res.json({ logs: [...dbLogs, ...runtimeLogs].slice(-200) });
});

router.delete("/bots/:id", (req, res) => {
  const user = req.user!;
  const dbBotId = parseInt(req.params["id"]!, 10);
  const row = UserBotRepo.getById(dbBotId);

  if (!row || row.user_id !== user.userId) {
    res.status(404).json({ error: "Bot not found" });
    return;
  }

  const manager = BotManager.getInstance();
  const runtimeId = row.runtime_id ?? manager.getUserBotRuntimeId(dbBotId);
  if (runtimeId) manager.removeBot(runtimeId, false);

  UserBotRepo.delete(dbBotId);
  res.json({ message: "Bot deleted" });
});

export default router;
