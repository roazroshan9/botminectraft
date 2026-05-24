import mineflayer, { type Bot } from "mineflayer";
import { pathfinder, Movements } from "../utils/pathfinder.js";
import { EventEmitter } from "node:events";
import { logger } from "../lib/logger.js";
import { TaskQueue } from "../utils/queue.js";
import { WaypointRepo, InventoryRepo, TaskHistoryRepo, StructureRepo } from "../database/Database.js";
import { detectServerVersion, findBestSupportedVersion } from "./version.js";
import { MiningPlugin } from "../plugins/MiningPlugin.js";
import { FarmingPlugin } from "../plugins/FarmingPlugin.js";
import { CombatPlugin } from "../plugins/CombatPlugin.js";
import { BuildingPlugin } from "../plugins/BuildingPlugin.js";
import { ExplorationPlugin } from "../plugins/ExplorationPlugin.js";
import { InventoryPlugin } from "../plugins/InventoryPlugin.js";
import { parseCommand } from "../commands/CommandParser.js";
import type { BotConfig } from "../config/defaults.js";

export type BotStatus = "disconnected" | "connecting" | "connected" | "error";

export interface BotStats {
  id: string;
  username: string;
  host: string;
  port: number;
  version: string;
  status: BotStatus;
  health: number;
  food: number;
  position: { x: number; y: number; z: number } | null;
  dimension: string;
  uptime: number;
  reconnectAttempts: number;
  currentTask: string | null;
  inventory: { name: string; count: number; slot: number }[];
  logs: string[];
}

export class MinecraftBot extends EventEmitter {
  readonly id: string;
  private config: BotConfig & { reconnect: boolean; reconnectDelay: number; reconnectMaxDelay: number };
  private bot: Bot | null = null;
  private status: BotStatus = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private startedAt: number = Date.now();
  private logs: string[] = [];
  private stopRequested = false;

  readonly taskQueue: TaskQueue;
  mining!: MiningPlugin;
  farming!: FarmingPlugin;
  combat!: CombatPlugin;
  building!: BuildingPlugin;
  exploration!: ExplorationPlugin;
  inventory!: InventoryPlugin;

  constructor(id: string, config: BotConfig) {
    super();
    this.id = id;
    this.config = {
      reconnect: true,
      reconnectDelay: 5000,
      reconnectMaxDelay: 60000,
      ...config,
    };
    this.taskQueue = new TaskQueue();
    this.taskQueue.onUpdate((tasks) => {
      this.emit("tasks", tasks);
    });
  }

  async connect() {
    if (this.status === "connecting" || this.status === "connected") return;
    this.status = "connecting";
    this.stopRequested = false;
    this.emit("status", this.status);
    this.log("Connecting to server...");

    try {
      let version = this.config.version || "1.20.1";
      try {
        const detected = await detectServerVersion(this.config.host, this.config.port);
        version = findBestSupportedVersion(detected);
        this.log(`Server version detected: ${version}`);
      } catch {
        this.log(`Version detection failed, using ${version}`);
      }

      this.bot = mineflayer.createBot({
        host: this.config.host,
        port: this.config.port,
        username: this.config.username,
        password: this.config.password,
        version,
        auth: this.config.auth || "offline",
        hideErrors: false,
        checkTimeoutInterval: 30000,
        closeTimeout: 10000,
        physicsEnabled: true,
        onMsaCode: (data: { user_code: string; verification_uri: string; expires_in: number }) => {
          this.log(`Microsoft auth required — visit ${data.verification_uri} and enter code: ${data.user_code}`);
          this.emit("auth_code", {
            url: data.verification_uri,
            code: data.user_code,
            expiresIn: data.expires_in,
          });
        },
      } as Parameters<typeof mineflayer.createBot>[0]);

      this.bot.loadPlugin(pathfinder);
      this.setupPlugins();
      this.setupEvents();
    } catch (err) {
      this.log(`Connection error: ${err instanceof Error ? err.message : String(err)}`);
      this.status = "error";
      this.emit("status", this.status);
      this.scheduleReconnect();
    }
  }

  private setupPlugins() {
    if (!this.bot) return;
    this.mining = new MiningPlugin(this.bot, this);
    this.farming = new FarmingPlugin(this.bot, this);
    this.combat = new CombatPlugin(this.bot, this);
    this.building = new BuildingPlugin(this.bot, this);
    this.exploration = new ExplorationPlugin(this.bot, this);
    this.inventory = new InventoryPlugin(this.bot, this);
  }

  private setupEvents() {
    if (!this.bot) return;
    const bot = this.bot;

    bot.once("spawn", () => {
      this.status = "connected";
      this.reconnectAttempts = 0;
      this.startedAt = Date.now();
      this.log(`Spawned as ${bot.username}`);
      this.emit("status", this.status);
      this.emit("spawn");
      this.restorePersistentState();
      this.setupMovements();
    });

    bot.on("chat", (username, message) => {
      if (username === bot.username) return;
      this.log(`<${username}> ${message}`);
      this.emit("chat", { username, message });
      this.handleChatCommand(username, message).catch(err => {
        logger.error({ err }, "Chat command error");
      });
    });

    bot.on("health", () => {
      this.emit("health", { health: bot.health, food: bot.food });
      if (bot.health <= 4) {
        this.log("⚠ Low health! Taking defensive action...");
        this.combat.flee().catch(() => {});
      }
    });

    bot.on("death", () => {
      this.log("Bot died. Respawning...");
      this.taskQueue.stopAll();
      setTimeout(() => bot.respawn?.(), 2000);
      this.emit("death");
    });

    bot.on("kicked", (reason) => {
      this.log(`Kicked: ${reason}`);
      this.status = "disconnected";
      this.emit("status", this.status);
      this.scheduleReconnect();
    });

    bot.on("error", (err) => {
      this.log(`Error: ${err.message}`);
      this.status = "error";
      this.emit("status", this.status);
      logger.error({ err, botId: this.id }, "Bot error");
    });

    bot.on("end", (reason) => {
      this.log(`Disconnected: ${reason || "unknown"}`);
      this.status = "disconnected";
      this.bot = null;
      this.emit("status", this.status);
      this.taskQueue.stopAll();
      this.scheduleReconnect();
    });

    bot.on("move", () => {
      this.emit("position", bot.entity?.position ?? null);
    });

    bot.on("entityHurt", (entity) => {
      if (entity === bot.entity) {
        this.emit("health", { health: bot.health, food: bot.food });
      }
    });

    setInterval(() => {
      if (this.status === "connected" && bot.inventory) {
        const items = this.getInventoryItems();
        InventoryRepo.saveSnapshot(this.id, items);
        this.emit("inventory", items);
      }
    }, 30000);
  }

  private setupMovements() {
    if (!this.bot) return;
    try {
      const movements = new Movements(this.bot);
      movements.allowSprinting = true;
      movements.allowParkour = true;
      movements.canDig = true;
      this.bot.pathfinder.setMovements(movements);
    } catch (err) {
      logger.warn({ err }, "Failed to setup movements");
    }
  }

  private restorePersistentState() {
    this.log("Restoring persistent state...");
  }

  private async handleChatCommand(username: string, message: string) {
    if (!message.startsWith("!")) return;
    const cmd = message.slice(1).trim();
    const parsed = parseCommand(cmd);
    if (!parsed) return;
    this.log(`Command from ${username}: ${cmd}`);
    await this.executeCommand(parsed.command, parsed.args, parsed.amount);
  }

  async executeCommand(command: string, args: string[] = [], amount?: number): Promise<string> {
    if (!this.bot) return "Bot is not connected";
    const bot = this.bot;

    switch (command.toLowerCase()) {
      case "stop":
        this.taskQueue.stopAll();
        return "Stopped all tasks";

      case "follow":
      case "followme": {
        const target = args[0] || [...Object.keys(bot.players || {})].find(p => p !== bot.username);
        if (!target) return "No player specified";
        const task = this.taskQueue.enqueue("follow", `Following ${target}`, () => this.combat.followPlayer(target));
        return `Following ${target} (task ${task.id})`;
      }

      case "mine":
      case "mine_ore": {
        const ore = args[0] || "diamond";
        const qty = amount || 1;
        const task = this.taskQueue.enqueue("mine", `Mining ${qty} ${ore}`, () => this.mining.mine(ore, qty));
        return `Mining ${qty} ${ore} (task ${task.id})`;
      }

      case "collect":
      case "farm": {
        const item = args[0] || "wood";
        const qty = amount || 32;
        if (["wheat", "carrots", "potatoes", "beetroot"].includes(item)) {
          const task = this.taskQueue.enqueue("farm", `Farming ${item}`, () => this.farming.farm(item));
          return `Farming ${item} (task ${task.id})`;
        }
        const task = this.taskQueue.enqueue("collect", `Collecting ${qty} ${item}`, () => this.mining.collectBlock(item, qty));
        return `Collecting ${qty} ${item} (task ${task.id})`;
      }

      case "craft": {
        const item = args[0];
        if (!item) return "Specify item to craft";
        const task = this.taskQueue.enqueue("craft", `Crafting ${item}`, () => this.inventory.craft(item, amount || 1));
        return `Crafting ${item} (task ${task.id})`;
      }

      case "goto":
      case "go": {
        const x = parseFloat(args[0] || "0");
        const y = parseFloat(args[1] || "64");
        const z = parseFloat(args[2] || "0");
        const task = this.taskQueue.enqueue("goto", `Going to ${x} ${y} ${z}`, () => this.exploration.goTo(x, y, z));
        return `Going to ${x} ${y} ${z} (task ${task.id})`;
      }

      case "find":
      case "explore": {
        const target = args[0] || "village";
        const task = this.taskQueue.enqueue("explore", `Finding ${target}`, () => this.exploration.findStructure(target));
        return `Searching for ${target} (task ${task.id})`;
      }

      case "attack":
      case "fight": {
        const mobType = args[0] || "zombie";
        const task = this.taskQueue.enqueue("combat", `Fighting ${mobType}`, () => this.combat.fightNearestMob(mobType));
        return `Fighting ${mobType} (task ${task.id})`;
      }

      case "defend": {
        const player = args[0];
        const task = this.taskQueue.enqueue("defend", `Defending ${player || "self"}`, () => this.combat.defend(player));
        return `Defending ${player || "self"} (task ${task.id})`;
      }

      case "deposit": {
        const task = this.taskQueue.enqueue("deposit", "Depositing items to chest", () => this.inventory.depositToNearestChest());
        return `Depositing items (task ${task.id})`;
      }

      case "organize": {
        const task = this.taskQueue.enqueue("organize", "Organizing inventory", () => this.inventory.organize());
        return `Organizing inventory (task ${task.id})`;
      }

      case "waypoint":
      case "wp": {
        const sub = args[0];
        if (sub === "save") {
          const name = args[1] || `wp_${Date.now()}`;
          const pos = bot.entity?.position;
          if (!pos) return "Unknown position";
          WaypointRepo.create({ id: `${this.id}_${name}`, bot_id: this.id, name, x: pos.x, y: pos.y, z: pos.z });
          return `Waypoint '${name}' saved at ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}`;
        }
        if (sub === "goto") {
          const wps = WaypointRepo.getByBot(this.id) as Array<{ name: string; x: number; y: number; z: number }>;
          const wp = wps.find(w => w.name === args[1]);
          if (!wp) return `Waypoint '${args[1]}' not found`;
          const task = this.taskQueue.enqueue("goto", `Going to waypoint ${wp.name}`, () => this.exploration.goTo(wp.x, wp.y, wp.z));
          return `Going to waypoint ${wp.name} (task ${task.id})`;
        }
        return "Usage: waypoint save <name> | waypoint goto <name>";
      }

      case "build": {
        const structure = args[0] || "house";
        const task = this.taskQueue.enqueue("build", `Building ${structure}`, () => this.building.build(structure));
        return `Building ${structure} (task ${task.id})`;
      }

      case "eat": {
        const task = this.taskQueue.enqueue("eat", "Eating food", () => this.inventory.eatFood());
        return `Eating food (task ${task.id})`;
      }

      case "status": {
        const pos = bot.entity?.position;
        return `Health: ${bot.health}/20 | Food: ${bot.food}/20 | Pos: ${pos ? `${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}` : "unknown"}`;
      }

      default:
        return `Unknown command: ${command}. Try: stop, follow, mine, collect, craft, goto, find, attack, defend, deposit, organize, build, status`;
    }
  }

  disconnect(permanent = false) {
    this.stopRequested = permanent;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.taskQueue.stopAll();
    if (this.bot) {
      try { this.bot.quit("Disconnecting"); } catch {}
      this.bot = null;
    }
    this.status = "disconnected";
    this.emit("status", this.status);
  }

  private scheduleReconnect() {
    if (this.stopRequested || !this.config.reconnect) return;

    const delay = Math.min(
      this.config.reconnectDelay * Math.pow(1.5, this.reconnectAttempts),
      this.config.reconnectMaxDelay,
    );
    this.reconnectAttempts++;
    this.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  log(message: string) {
    const entry = `[${new Date().toISOString()}] ${message}`;
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.shift();
    this.emit("log", entry);
    logger.info({ botId: this.id }, message);
  }

  getStats(): BotStats {
    const bot = this.bot;
    return {
      id: this.id,
      username: this.config.username,
      host: this.config.host,
      port: this.config.port,
      version: this.config.version || "1.20.1",
      status: this.status,
      health: bot?.health ?? 0,
      food: bot?.food ?? 0,
      position: bot?.entity?.position
        ? { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) }
        : null,
      dimension: (bot as unknown as Record<string, unknown>)?.game?.dimension ?? "overworld",
      uptime: this.status === "connected" ? Date.now() - this.startedAt : 0,
      reconnectAttempts: this.reconnectAttempts,
      currentTask: this.taskQueue.getCurrent()?.name ?? null,
      inventory: this.getInventoryItems(),
      logs: this.logs.slice(-50),
    };
  }

  getInventoryItems(): { name: string; count: number; slot: number }[] {
    if (!this.bot) return [];
    return (this.bot.inventory.slots || [])
      .filter(Boolean)
      .map((item) => ({ name: item!.name, count: item!.count, slot: item!.slot }));
  }

  getRawBot(): Bot | null { return this.bot; }
  getStatus(): BotStatus { return this.status; }
  getLogs(): string[] { return [...this.logs]; }
}
