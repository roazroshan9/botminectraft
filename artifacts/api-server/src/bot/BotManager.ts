import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { MinecraftBot } from "./MinecraftBot.js";
import { BotRepo } from "../database/Database.js";
import { logger } from "../lib/logger.js";
import type { BotConfig } from "../config/defaults.js";

export class BotManager extends EventEmitter {
  private bots: Map<string, MinecraftBot> = new Map();
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
          const bot = this.createBot(row.id, {
            username: row.username,
            host: row.host,
            port: row.port,
            version: row.version,
            auth: row.auth,
            password: row.password,
          });
          bot.connect().catch(err => logger.error({ err, botId: row.id }, "Auto-connect failed"));
        }
      }
      logger.info({ count: saved.length }, "Loaded saved bots");
    } catch (err) {
      logger.error({ err }, "Failed to load saved bots");
    }
  }

  addBot(config: BotConfig & { autoConnect?: boolean }): MinecraftBot {
    const id = randomUUID();

    BotRepo.create({
      id,
      username: config.username,
      host: config.host,
      port: config.port || 25565,
      version: config.version || "1.20.1",
      auth: config.auth || "offline",
      password: config.password,
    });

    const bot = this.createBot(id, config);
    if (config.autoConnect !== false) {
      bot.connect().catch(err => logger.error({ err, botId: id }, "Connect failed"));
    }
    return bot;
  }

  private createBot(id: string, config: BotConfig): MinecraftBot {
    const bot = new MinecraftBot(id, config);

    bot.on("status", (status) => {
      this.emit("bot:status", { id, status });
    });
    bot.on("log", (entry) => {
      this.emit("bot:log", { id, entry });
    });
    bot.on("chat", (data) => {
      this.emit("bot:chat", { id, ...data });
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
    bot.on("tasks", (tasks) => {
      this.emit("bot:tasks", { id, tasks });
    });

    this.bots.set(id, bot);
    this.emit("bot:added", { id });
    logger.info({ botId: id, username: config.username }, "Bot added");
    return bot;
  }

  removeBot(id: string, permanent = true): boolean {
    const bot = this.bots.get(id);
    if (!bot) return false;
    bot.disconnect(true);
    this.bots.delete(id);
    if (permanent) {
      BotRepo.delete(id);
    }
    this.emit("bot:removed", { id });
    logger.info({ botId: id }, "Bot removed");
    return true;
  }

  getBot(id: string): MinecraftBot | undefined {
    return this.bots.get(id);
  }

  getAllBots(): MinecraftBot[] {
    return [...this.bots.values()];
  }

  getAllStats() {
    return [...this.bots.values()].map(b => b.getStats());
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
