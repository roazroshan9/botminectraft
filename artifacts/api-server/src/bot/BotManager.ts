import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { MinecraftBot } from "./MinecraftBot.js";
import { BotRepo, UserBotRepo } from "../database/Database.js";
import { logger } from "../lib/logger.js";
import type { BotConfig } from "../config/defaults.js";

export class BotManager extends EventEmitter {
  private bots:      Map<string, MinecraftBot> = new Map();
  private botOwners: Map<string, number>       = new Map(); // runtimeId → userId
  private botDbIds:  Map<string, number>       = new Map(); // runtimeId → dbBotId
  private botUsernames: Map<string, string>    = new Map(); // runtimeId → ownerUsername
  private static instance: BotManager;

  static getInstance(): BotManager {
    if (!BotManager.instance) BotManager.instance = new BotManager();
    return BotManager.instance;
  }

  private constructor() {
    super();
    this.loadSavedBots();
  }

  private loadSavedBots() {
    try {
      const saved = BotRepo.getAll() as Array<{
        id: string; username: string; host: string; port: number;
        version: string; auth: "offline" | "microsoft"; password?: string; enabled: number;
      }>;
      for (const row of saved) {
        if (row.enabled) {
          const bot = this.createBot(row.id, row, "System");
          bot.connect().catch(err => logger.error({ err, botId: row.id }, "Auto-connect failed"));
        }
      }
      logger.info({ count: saved.length }, "Loaded saved bots");
    } catch (err) {
      logger.error({ err }, "Failed to load saved bots");
    }
  }

  // ── Admin-managed bot ───────────────────────────────────────────────────────
  addBot(config: BotConfig & { autoConnect?: boolean }): MinecraftBot {
    const id = randomUUID();
    BotRepo.create({
      id,
      username: config.username,
      host:     config.host,
      port:     config.port || 25565,
      version:  config.version || "1.20.1",
      auth:     config.auth   || "offline",
      password: config.password,
    });
    const bot = this.createBot(id, config, "Admin");
    if (config.autoConnect !== false) {
      bot.connect().catch(err => logger.error({ err, botId: id }, "Connect failed"));
    }
    return bot;
  }

  // ── User-managed bot ────────────────────────────────────────────────────────
  addUserBot(
    userId: number,
    dbBotId: number,
    config: BotConfig & { autoConnect?: boolean },
    ownerUsername = "User",
  ): MinecraftBot {
    const runtimeId = randomUUID();
    UserBotRepo.updateStatus(dbBotId, "connecting", null, runtimeId);

    const bot = this.createBot(runtimeId, config, ownerUsername);
    this.botOwners.set(runtimeId, userId);
    this.botDbIds.set(runtimeId, dbBotId);
    this.botUsernames.set(runtimeId, ownerUsername);

    bot.on("status", (status: string) => {
      UserBotRepo.updateStatus(dbBotId, status, bot.taskQueue.getCurrent()?.name ?? null, runtimeId);
    });

    if (config.autoConnect !== false) {
      bot.connect().catch(err => logger.error({ err, botId: runtimeId }, "User bot connect failed"));
    }
    return bot;
  }

  // ── Core bot factory (wires all events) ────────────────────────────────────
  private createBot(id: string, config: BotConfig, ownerUsername: string): MinecraftBot {
    const bot = new MinecraftBot(id, config);

    bot.on("status", (status) => {
      this.emit("bot:status", { id, status, username: config.username });
    });

    // Include ownerUsername in every log event so the admin feed can label entries
    bot.on("log", (entry) => {
      this.emit("bot:log", { id, entry, username: ownerUsername, botUsername: config.username });
    });

    bot.on("chat", (data) => {
      this.emit("bot:chat", { id, username: ownerUsername, ...data });
    });

    bot.on("health", (data) => {
      this.emit("bot:health", { id, ...data });
    });

    bot.on("position", (pos) => {
      this.emit("bot:position", { id, pos });
    });

    bot.on("inventory", (items) => {
      this.emit("bot:inventory", { id, items });
    });

    // Forward task list with progress updates — fire on every change
    bot.on("tasks", (tasks) => {
      this.emit("bot:tasks", { id, tasks });
    });

    // Task completion event → emit separately for dashboard flash
    bot.on("task:done", (task) => {
      this.emit("bot:task_done", { id, task, username: ownerUsername });
    });

    bot.on("auth_code", (data: { url: string; code: string; expiresIn: number }) => {
      const userId = this.botOwners.get(id);
      this.emit("bot:auth_code", { id, userId, ...data });
      logger.info({ botId: id, userId }, "Microsoft auth code event emitted");
    });

    this.bots.set(id, bot);
    this.emit("bot:added", { id });
    logger.info({ botId: id, username: config.username, owner: ownerUsername }, "Bot added");
    return bot;
  }

  // ── Management ──────────────────────────────────────────────────────────────
  removeBot(id: string, permanent = true): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;
    bot.disconnect(true);
    this.bots.delete(id);
    const dbId = this.botDbIds.get(id);
    if (dbId) {
      UserBotRepo.updateStatus(dbId, "offline", null, null);
      this.botDbIds.delete(id);
    }
    this.botOwners.delete(id);
    this.botUsernames.delete(id);
    if (permanent) BotRepo.delete(id);
    this.emit("bot:removed", { id });
    logger.info({ botId: id }, "Bot removed");
    return true;
  }

  getBot(id: string):    MinecraftBot | undefined { return this.bots.get(id); }
  getAllBots():           MinecraftBot[]           { return [...this.bots.values()]; }
  getAllStats()                                    { return [...this.bots.values()].map(b => b.getStats()); }
  getBotOwner(id: string): number | undefined     { return this.botOwners.get(id); }
  getBotDbId(id: string):  number | undefined     { return this.botDbIds.get(id); }
  getBotUsername(id: string): string              { return this.botUsernames.get(id) ?? "System"; }

  getUserBotRuntimeId(dbBotId: number): string | undefined {
    for (const [runtimeId, id] of this.botDbIds.entries()) {
      if (id === dbBotId) return runtimeId;
    }
    return undefined;
  }

  connectBot(id: string): Promise<void> {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    return bot.connect();
  }

  disconnectBot(id: string) {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    bot.disconnect();
  }

  async sendCommand(id: string, command: string, args: string[] = [], amount?: number): Promise<string> {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Bot ${id} not found`);
    return bot.executeCommand(command, args, amount);
  }
}
