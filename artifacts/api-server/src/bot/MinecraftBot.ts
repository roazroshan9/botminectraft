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
  mining!:      MiningPlugin;
  farming!:     FarmingPlugin;
  combat!:      CombatPlugin;
  building!:    BuildingPlugin;
  exploration!: ExplorationPlugin;
  inventory!:   InventoryPlugin;

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

    // Forward task list changes
    this.taskQueue.onUpdate((tasks) => {
      this.emit("tasks", tasks);
    });

    // Emit completion events so dashboards show a "Done / Failed" flash
    this.taskQueue.onDone((task) => {
      const icon = task.status === "done" ? "✅" : task.status === "failed" ? "❌" : "⏹";
      this.log(`${icon} Task "${task.name}" ${task.status}${task.error ? ": " + task.error : ""}`);
      this.emit("task:done", task);
    });
  }

  // ─── connect ───────────────────────────────────────────────────────────────
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
        host:     this.config.host,
        port:     this.config.port,
        username: this.config.username,
        password: this.config.password,
        version,
        auth:     this.config.auth || "offline",
        hideErrors: false,
        checkTimeoutInterval: 30000,
        closeTimeout: 10000,
        physicsEnabled: true,
        onMsaCode: (data: { user_code: string; verification_uri: string; expires_in: number }) => {
          this.log(`Microsoft auth — visit ${data.verification_uri} and enter: ${data.user_code}`);
          this.emit("auth_code", { url: data.verification_uri, code: data.user_code, expiresIn: data.expires_in });
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

  // ─── plugin init ───────────────────────────────────────────────────────────
  private setupPlugins() {
    if (!this.bot) return;
    this.mining      = new MiningPlugin(this.bot, this);
    this.farming     = new FarmingPlugin(this.bot, this);
    this.combat      = new CombatPlugin(this.bot, this);
    this.building    = new BuildingPlugin(this.bot, this);
    this.exploration = new ExplorationPlugin(this.bot, this);
    this.inventory   = new InventoryPlugin(this.bot, this);
  }

  // ─── mineflayer event wiring ───────────────────────────────────────────────
  private setupEvents() {
    if (!this.bot) return;
    const bot = this.bot;

    bot.once("spawn", () => {
      this.status = "connected";
      this.reconnectAttempts = 0;
      this.startedAt = Date.now();
      this.log(`✅ Spawned as ${bot.username} on ${this.config.host}:${this.config.port}`);
      this.emit("status", this.status);
      this.emit("spawn");
      this.setupMovements();
      this.restorePersistentState();
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
        this.log("⚠ Critical health! Fleeing...");
        this.combat.flee().catch(() => {});
      }
    });

    bot.on("death", () => {
      this.log("💀 Bot died — respawning...");
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
      this.log(`Socket error: ${err.message}`);
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
      if (entity === bot.entity) this.emit("health", { health: bot.health, food: bot.food });
    });

    // Periodic inventory snapshot + stat broadcast
    setInterval(() => {
      if (this.status !== "connected" || !bot.inventory) return;
      const items = this.getInventoryItems();
      InventoryRepo.saveSnapshot(this.id, items);
      this.emit("inventory", items);
      // Also re-broadcast status with current task so dashboards stay live
      this.emit("tasks", this.taskQueue.getCurrent()
        ? [this.taskQueue.getCurrent()!, ...this.taskQueue.getQueue()]
        : this.taskQueue.getQueue());
    }, 30000);
  }

  // ─── pathfinder setup ──────────────────────────────────────────────────────
  private setupMovements() {
    if (!this.bot) return;
    try {
      const movements = new Movements(this.bot);
      movements.allowSprinting  = true;
      movements.allowParkour    = true;
      movements.canDig          = true;
      this.bot.pathfinder.setMovements(movements);
    } catch (err) {
      logger.warn({ err }, "Failed to setup movements");
    }
  }

  private restorePersistentState() {
    this.log("State restored.");
  }

  // ─── in-game chat command handler ──────────────────────────────────────────
  private async handleChatCommand(username: string, message: string) {
    if (!message.startsWith("!")) return;
    const cmd = message.slice(1).trim();
    const parsed = parseCommand(cmd);
    if (!parsed) return;
    this.log(`Command from ${username}: ${cmd}`);
    const result = await this.executeCommand(parsed.command, parsed.args, parsed.amount);
    // Echo result back in-game
    try { this.bot?.chat(result.slice(0, 256)); } catch {}
  }

  // ─── core command dispatcher ───────────────────────────────────────────────
  async executeCommand(command: string, args: string[] = [], amount?: number): Promise<string> {
    if (!this.bot) return "Bot is not connected";

    const cmd = command.toLowerCase().trim();

    switch (cmd) {
      // ── Control ──────────────────────────────────────────────────────────
      case "stop": {
        this.taskQueue.stopAll();
        this.mining.cancel();
        this.farming.cancel();
        this.combat.cancel();
        this.exploration.cancel();
        return "⏹ All tasks stopped";
      }

      case "status": {
        const pos = this.bot.entity?.position;
        const task = this.taskQueue.getCurrent();
        return [
          `❤ ${Math.round(this.bot.health)}/20 HP`,
          `🍖 ${Math.round(this.bot.food)}/20 Food`,
          pos ? `📍 ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}` : "📍 unknown",
          task ? `⚡ Task: ${task.name} (${task.progress}%)` : "💤 Idle",
        ].join("  |  ");
      }

      // ── Navigation ────────────────────────────────────────────────────────
      case "goto":
      case "go": {
        // parseCommand extracts the first non-negative integer as `amount`.
        // For goto the first token is the X coord, which can be positive or negative.
        // Reconstruction: if amount captured X, args holds [y, z]; otherwise all in args.
        let x: number, y: number, z: number;
        if (args.length >= 3) {
          // All three coords came through as args (e.g. all were negative or non-integer)
          x = parseFloat(args[0]!); y = parseFloat(args[1]!); z = parseFloat(args[2]!);
        } else if (amount !== undefined && args.length === 2) {
          // amount = X, args = [Y, Z]
          x = amount; y = parseFloat(args[0]!); z = parseFloat(args[1]!);
        } else if (amount !== undefined && args.length === 1) {
          // amount = X, args = [Y], Z defaults to 0
          x = amount; y = parseFloat(args[0]!); z = 0;
        } else if (amount !== undefined && args.length === 0) {
          // Only X provided
          x = amount; y = 64; z = 0;
        } else {
          x = parseFloat(args[0] ?? "0"); y = parseFloat(args[1] ?? "64"); z = parseFloat(args[2] ?? "0");
        }
        if (isNaN(x) || isNaN(y) || isNaN(z)) return "Usage: goto <x> <y> <z>";
        const task = this.taskQueue.enqueue(
          "goto", `Navigate to ${Math.round(x)} ${Math.round(y)} ${Math.round(z)}`,
          () => this.exploration.goTo(x, y, z),
        );
        return `🧭 Navigating to ${Math.round(x)} ${Math.round(y)} ${Math.round(z)} [${task.id}]`;
      }

      case "patrol": {
        // patrol <x1,y1,z1> <x2,y2,z2> ... or use saved waypoints
        if (args.length === 0) {
          // Patrol saved waypoints
          const task = this.taskQueue.enqueue(
            "patrol", "Patrol saved waypoints",
            () => this.exploration.patrolSavedWaypoints(0),
            () => this.exploration.cancel(),
          );
          return `🗺 Patrolling saved waypoints [${task.id}]`;
        }
        // Parse inline coords: patrol 0 64 0 100 64 0 (groups of 3)
        const wps: { x:number; y:number; z:number }[] = [];
        for (let i = 0; i + 2 < args.length; i += 3) {
          wps.push({ x: parseFloat(args[i]!), y: parseFloat(args[i+1]!), z: parseFloat(args[i+2]!) });
        }
        if (wps.length < 2) return "Usage: patrol [x1 y1 z1] [x2 y2 z2] ... (min 2 waypoints)";
        const task = this.taskQueue.enqueue(
          "patrol", `Patrol ${wps.length} waypoints`,
          () => this.exploration.patrol(wps, 0),
          () => this.exploration.cancel(),
        );
        return `🗺 Patrolling ${wps.length} waypoints [${task.id}]`;
      }

      case "find":
      case "explore": {
        const target = args[0] || "village";
        const task = this.taskQueue.enqueue(
          "explore", `Finding ${target}`,
          () => this.exploration.findStructure(target),
          () => this.exploration.cancel(),
        );
        return `🔍 Searching for ${target} [${task.id}]`;
      }

      // ── Mining ────────────────────────────────────────────────────────────
      case "mine": {
        const ore = args[0] || "diamond";
        const qty = amount ?? 1;
        const task = this.taskQueue.enqueue(
          "mine", `Mine ${qty}× ${ore}`,
          () => this.mining.mine(ore, qty),
          () => this.mining.cancel(),
        );
        return `⛏ Mining ${qty}× ${ore} [${task.id}]`;
      }

      case "collect": {
        const item = args[0] || "wood";
        const qty = amount ?? 32;
        // Route crop names to farming instead
        if (["wheat","carrots","potatoes","beetroot","melon","pumpkin","sugar_cane","bamboo","cactus"].includes(item)) {
          const task = this.taskQueue.enqueue(
            "farm", `Farm ${item}`,
            () => this.farming.farm(item),
            () => this.farming.cancel(),
          );
          return `🌾 Farming ${item} [${task.id}]`;
        }
        const task = this.taskQueue.enqueue(
          "collect", `Collect ${qty}× ${item}`,
          () => this.mining.collectBlock(item, qty),
          () => this.mining.cancel(),
        );
        return `📦 Collecting ${qty}× ${item} [${task.id}]`;
      }

      // ── Farming ───────────────────────────────────────────────────────────
      case "farm": {
        const crop = args[0] || "wheat";
        const TREE_NAMES = new Set(["oak","birch","spruce","jungle","acacia","dark_oak","mangrove","cherry","wood","logs"]);
        if (TREE_NAMES.has(crop)) {
          const qty = amount ?? 32;
          const task = this.taskQueue.enqueue(
            "chop", `Chop ${qty}× ${crop}`,
            () => this.farming.chopTrees(crop, qty),
            () => this.farming.cancel(),
          );
          return `🪓 Chopping ${qty}× ${crop} logs [${task.id}]`;
        }
        const task = this.taskQueue.enqueue(
          "farm", `Farm ${crop}`,
          () => this.farming.farm(crop),
          () => this.farming.cancel(),
        );
        return `🌾 Farming ${crop} [${task.id}]`;
      }

      case "chop": {
        const treeType = args[0] || "oak";
        const qty = amount ?? 32;
        const task = this.taskQueue.enqueue(
          "chop", `Chop ${qty}× ${treeType} logs`,
          () => this.farming.chopTrees(treeType, qty),
          () => this.farming.cancel(),
        );
        return `🪓 Chopping ${qty}× ${treeType} logs [${task.id}]`;
      }

      // ── Combat ────────────────────────────────────────────────────────────
      case "attack": {
        const mob = args[0] || "zombie";
        const task = this.taskQueue.enqueue(
          "combat", `Fight ${mob}`,
          () => this.combat.fightNearestMob(mob),
          () => this.combat.cancel(),
        );
        return `⚔ Fighting ${mob} [${task.id}]`;
      }

      case "defend": {
        const player = args[0];
        const task = this.taskQueue.enqueue(
          "defend", `Defend ${player || "self"}`,
          () => this.combat.defend(player),
          () => this.combat.cancel(),
        );
        return `🛡 Defending ${player || "self"} [${task.id}]`;
      }

      case "follow": {
        const target = args[0] || [...Object.keys(this.bot.players ?? {})].find(p => p !== this.bot!.username);
        if (!target) return "No player to follow — specify a name";
        const task = this.taskQueue.enqueue(
          "follow", `Follow ${target}`,
          () => this.combat.followPlayer(target),
          () => this.combat.cancel(),
        );
        return `🏃 Following ${target} [${task.id}]`;
      }

      // ── Inventory ─────────────────────────────────────────────────────────
      case "craft": {
        const item = args[0];
        if (!item) return "Usage: craft <item> [amount]";
        const task = this.taskQueue.enqueue(
          "craft", `Craft ${amount ?? 1}× ${item}`,
          () => this.inventory.craft(item, amount ?? 1),
        );
        return `🔨 Crafting ${amount ?? 1}× ${item} [${task.id}]`;
      }

      case "deposit": {
        const task = this.taskQueue.enqueue(
          "deposit", "Deposit items to chest",
          () => this.inventory.depositToNearestChest(),
        );
        return `📥 Depositing to nearest chest [${task.id}]`;
      }

      case "organize": {
        const task = this.taskQueue.enqueue(
          "organize", "Organize inventory",
          () => this.inventory.organize(),
        );
        return `🗂 Organizing inventory [${task.id}]`;
      }

      case "eat": {
        const task = this.taskQueue.enqueue("eat", "Eat food", () => this.inventory.eatFood());
        return `🍖 Eating food [${task.id}]`;
      }

      // ── Waypoints ─────────────────────────────────────────────────────────
      case "waypoint":
      case "wp": {
        const sub = args[0];
        if (sub === "save") {
          const name = args[1] || `wp_${Date.now()}`;
          const pos  = this.bot.entity?.position;
          if (!pos) return "Unknown position";
          WaypointRepo.create({
            id: `${this.id}_${name}`,
            bot_id: this.id,
            name,
            x: pos.x, y: pos.y, z: pos.z,
          });
          return `📌 Waypoint '${name}' saved at ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}`;
        }
        if (sub === "goto") {
          const wps = WaypointRepo.getByBot(this.id) as Array<{ name: string; x: number; y: number; z: number }>;
          const wp = wps.find(w => w.name === args[1]);
          if (!wp) return `Waypoint '${args[1]}' not found`;
          const task = this.taskQueue.enqueue(
            "goto", `Go to waypoint ${wp.name}`,
            () => this.exploration.goTo(wp.x, wp.y, wp.z),
          );
          return `🧭 Going to waypoint '${wp.name}' [${task.id}]`;
        }
        return "Usage: waypoint save <name> | waypoint goto <name>";
      }

      // ── Building ──────────────────────────────────────────────────────────
      case "build": {
        const structure = args[0] || "house";
        const task = this.taskQueue.enqueue(
          "build", `Build ${structure}`,
          () => this.building.build(structure),
        );
        return `🏗 Building ${structure} [${task.id}]`;
      }

      // ── Fishing (stub) ────────────────────────────────────────────────────
      case "fish": {
        const qty = amount ?? 10;
        const task = this.taskQueue.enqueue(
          "fish", `Fish ${qty} items`,
          () => this.doFishing(qty),
        );
        return `🎣 Fishing for ${qty} items [${task.id}]`;
      }

      default:
        return `Unknown command: "${command}". Available: stop, status, goto, patrol, find, mine, collect, farm, chop, attack, defend, follow, craft, deposit, organize, eat, waypoint, build, fish`;
    }
  }

  // ─── Fishing (basic mineflayer fishing loop) ───────────────────────────────
  private async doFishing(qty: number): Promise<void> {
    const { sleep } = await import("../utils/helpers.js");
    let caught = 0;
    const taskId = this.taskQueue.getCurrentId();

    this.log(`🎣 Starting fishing — target ${qty} items`);

    // Equip fishing rod
    const rodId = this.bot?.registry.itemsByName["fishing_rod"]?.id ?? -1;
    const rod = this.bot?.inventory.findInventoryItem(rodId, null);
    if (!rod) { this.log("No fishing rod in inventory"); return; }
    try { await this.bot?.equip(rod, "hand"); } catch { return; }

    while (caught < qty && this.bot) {
      try {
        await (this.bot as unknown as { fish(): Promise<void> }).fish();
        caught++;
        this.taskQueue.updateProgress(taskId, Math.round((caught / qty) * 100));
        this.log(`🎣 Caught item ${caught}/${qty}`);
      } catch (err) {
        this.log(`Fishing error: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(3000);
      }
    }

    this.log(`🎣 Fishing complete — caught ${caught} items`);
  }

  // ─── disconnect / reconnect ────────────────────────────────────────────────
  disconnect(permanent = false) {
    this.stopRequested = permanent;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.taskQueue.stopAll();
    this.mining.cancel();
    this.farming.cancel();
    this.combat.cancel();
    this.exploration.cancel();
    if (this.bot) { try { this.bot.quit("Disconnecting"); } catch {} this.bot = null; }
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
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  // ─── logging / stats ───────────────────────────────────────────────────────
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
      id:                this.id,
      username:          this.config.username,
      host:              this.config.host,
      port:              this.config.port,
      version:           this.config.version || "1.20.1",
      status:            this.status,
      health:            bot?.health ?? 0,
      food:              bot?.food   ?? 0,
      position:          bot?.entity?.position
        ? { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) }
        : null,
      dimension:         (bot as unknown as Record<string, unknown>)?.game?.dimension as string ?? "overworld",
      uptime:            this.status === "connected" ? Date.now() - this.startedAt : 0,
      reconnectAttempts: this.reconnectAttempts,
      currentTask:       this.taskQueue.getCurrent()?.name ?? null,
      inventory:         this.getInventoryItems(),
      logs:              this.logs.slice(-50),
    };
  }

  getInventoryItems(): { name: string; count: number; slot: number }[] {
    if (!this.bot) return [];
    return (this.bot.inventory.slots || [])
      .filter(Boolean)
      .map(item => ({ name: item!.name, count: item!.count, slot: item!.slot }));
  }

  getRawBot():   Bot | null  { return this.bot; }
  getStatus():   BotStatus   { return this.status; }
  getLogs():     string[]    { return [...this.logs]; }
}
