export const DEFAULT_CONFIG = {
  bot: {
    version: "1.20.1",
    host: "localhost",
    port: 25565,
    username: "MinecraftAI",
    auth: "offline" as "offline" | "microsoft",
    reconnect: true,
    reconnectDelay: 5000,
    reconnectMaxDelay: 60000,
    reconnectMultiplier: 1.5,
    reconnectMaxAttempts: 0,
  },
  dashboard: {
    password: process.env["DASHBOARD_PASSWORD"] || "admin",
    port: Number(process.env["PORT"] || 3000),
    rateLimit: {
      windowMs: 15 * 60 * 1000,
      max: 100,
    },
  },
  memory: {
    gcInterval: 60000,
    maxLogEntries: 1000,
    maxTaskHistory: 500,
  },
  pathfinding: {
    range: 64,
    timeout: 30000,
  },
  mining: {
    maxDepth: 60,
    torchInterval: 8,
    safetyRadius: 3,
  },
  farming: {
    scanRadius: 32,
    harvestInterval: 30000,
  },
  exploration: {
    scanRadius: 128,
    waypointSaveDistance: 100,
  },
  combat: {
    attackRange: 4,
    fleeHealthThreshold: 6,
    shieldUsage: true,
  },
};

export type BotConfig = {
  host: string;
  port: number;
  username: string;
  password?: string;
  version?: string;
  auth?: "offline" | "microsoft";
};

export const SUPPORTED_VERSIONS = [
  "1.16.1", "1.16.2", "1.16.3", "1.16.4", "1.16.5",
  "1.17", "1.17.1",
  "1.18", "1.18.1", "1.18.2",
  "1.19", "1.19.1", "1.19.2", "1.19.3", "1.19.4",
  "1.20", "1.20.1", "1.20.2", "1.20.3", "1.20.4", "1.20.5", "1.20.6",
  "1.21", "1.21.1", "1.21.2", "1.21.3", "1.21.4",
];

export const ORE_TYPES: Record<string, { block: string; minY?: number; maxY?: number }> = {
  coal:      { block: "coal_ore",      maxY: 128 },
  iron:      { block: "iron_ore",      maxY: 64  },
  gold:      { block: "gold_ore",      maxY: 32  },
  redstone:  { block: "redstone_ore",  maxY: 16  },
  lapis:     { block: "lapis_ore",     maxY: 32  },
  emerald:   { block: "emerald_ore",   maxY: 32  },
  diamond:   { block: "diamond_ore",   maxY: 16  },
  debris:    { block: "ancient_debris", minY: 8, maxY: 119 },
  quartz:    { block: "nether_quartz_ore" },
  copper:    { block: "copper_ore",    maxY: 96  },
};

export const CROP_TYPES: Record<string, { seed: string; mature: number }> = {
  wheat:    { seed: "wheat_seeds",    mature: 7 },
  carrots:  { seed: "carrot",         mature: 7 },
  potatoes: { seed: "potato",         mature: 7 },
  beetroot: { seed: "beetroot_seeds", mature: 3 },
};
