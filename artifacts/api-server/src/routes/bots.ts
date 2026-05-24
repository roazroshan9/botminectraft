import { Router } from "express";
import { BotManager } from "../bot/BotManager.js";
import { WaypointRepo, TaskHistoryRepo, StructureRepo } from "../database/Database.js";
import { parseCommand } from "../commands/CommandParser.js";

const router = Router();
const manager = BotManager.getInstance();

router.get("/", (_req, res) => {
  res.json({ bots: manager.getAllStats() });
});

router.post("/", (req, res) => {
  const { host, port, username, version, auth, password } = req.body as Record<string, string>;
  if (!host || !username) {
    res.status(400).json({ error: "host and username are required" });
    return;
  }
  const bot = manager.addBot({
    host,
    port: parseInt(port || "25565", 10),
    username,
    version: version || "1.20.1",
    auth: (auth as "offline" | "microsoft") || "offline",
    password,
  });
  res.status(201).json({ id: bot.id, message: "Bot created and connecting" });
});

router.get("/:id", (req, res) => {
  const bot = manager.getBot(req.params["id"]!);
  if (!bot) { res.status(404).json({ error: "Bot not found" }); return; }
  res.json(bot.getStats());
});

router.delete("/:id", (req, res) => {
  const ok = manager.removeBot(req.params["id"]!);
  if (!ok) { res.status(404).json({ error: "Bot not found" }); return; }
  res.json({ message: "Bot removed" });
});

router.post("/:id/connect", async (req, res) => {
  try {
    await manager.connectBot(req.params["id"]!);
    res.json({ message: "Connecting..." });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/:id/disconnect", (req, res) => {
  try {
    manager.disconnectBot(req.params["id"]!);
    res.json({ message: "Disconnected" });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.post("/:id/command", async (req, res) => {
  const { command, args, amount, raw } = req.body as { command?: string; args?: string[]; amount?: number; raw?: string };
  const botId = req.params["id"]!;

  try {
    let result: string;
    if (raw) {
      const parsed = parseCommand(raw);
      if (!parsed) { res.status(400).json({ error: "Invalid command" }); return; }
      result = await manager.sendCommand(botId, parsed.command, parsed.args, parsed.amount);
    } else if (command) {
      result = await manager.sendCommand(botId, command, args || [], amount);
    } else {
      res.status(400).json({ error: "Provide command or raw" });
      return;
    }
    res.json({ result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.get("/:id/waypoints", (req, res) => {
  res.json({ waypoints: WaypointRepo.getByBot(req.params["id"]!) });
});

router.delete("/:id/waypoints/:wpId", (req, res) => {
  WaypointRepo.delete(req.params["wpId"]!);
  res.json({ message: "Deleted" });
});

router.get("/:id/tasks", (req, res) => {
  const bot = manager.getBot(req.params["id"]!);
  if (!bot) { res.status(404).json({ error: "Bot not found" }); return; }
  res.json({
    current: bot.taskQueue.getCurrent(),
    queue: bot.taskQueue.getQueue(),
    history: TaskHistoryRepo.getByBot(req.params["id"]!),
  });
});

router.post("/:id/tasks/stop", (req, res) => {
  const bot = manager.getBot(req.params["id"]!);
  if (!bot) { res.status(404).json({ error: "Bot not found" }); return; }
  bot.taskQueue.stopAll();
  res.json({ message: "All tasks stopped" });
});

router.get("/:id/structures", (req, res) => {
  res.json({ structures: StructureRepo.getByBot(req.params["id"]!) });
});

router.get("/:id/logs", (req, res) => {
  const bot = manager.getBot(req.params["id"]!);
  if (!bot) { res.status(404).json({ error: "Bot not found" }); return; }
  res.json({ logs: bot.getLogs() });
});

export default router;
