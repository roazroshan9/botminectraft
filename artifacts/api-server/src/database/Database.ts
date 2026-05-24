import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../lib/logger.js";

const DB_DIR = process.env["DATA_DIR"] || path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "mcbot.db");

let db: DatabaseSync;

export function initDatabase(): DatabaseSync {
  if (db) return db;

  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 25565,
      version TEXT DEFAULT '1.20.1',
      auth TEXT DEFAULT 'offline',
      password TEXT,
      enabled INTEGER DEFAULT 1,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS waypoints (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      dimension TEXT DEFAULT 'overworld',
      description TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS task_history (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending',
      started_at INTEGER,
      finished_at INTEGER,
      error TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS structures (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      type TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      dimension TEXT DEFAULT 'overworld',
      discovered_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS inventory_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    );
  `);

  logger.info({ path: DB_PATH }, "Database initialized");
  return db;
}

export function getDatabase(): DatabaseSync {
  if (!db) initDatabase();
  return db;
}

export const BotRepo = {
  getAll() {
    return getDatabase().prepare("SELECT * FROM bots ORDER BY created_at DESC").all() as Record<string, unknown>[];
  },
  getById(id: string) {
    return getDatabase().prepare("SELECT * FROM bots WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  },
  create(bot: { id: string; username: string; host: string; port: number; version: string; auth: string; password?: string }) {
    getDatabase().prepare(
      "INSERT INTO bots (id, username, host, port, version, auth, password) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(bot.id, bot.username, bot.host, bot.port, bot.version, bot.auth, bot.password ?? null);
  },
  update(id: string, data: Partial<{ username: string; host: string; port: number; version: string; enabled: number }>) {
    const fields = Object.keys(data).map(k => `${k} = ?`).join(", ");
    getDatabase().prepare(`UPDATE bots SET ${fields}, updated_at = unixepoch() WHERE id = ?`)
      .run(...Object.values(data), id);
  },
  delete(id: string) {
    getDatabase().prepare("DELETE FROM bots WHERE id = ?").run(id);
  },
};

export const WaypointRepo = {
  getByBot(botId: string) {
    return getDatabase().prepare("SELECT * FROM waypoints WHERE bot_id = ? ORDER BY created_at DESC").all(botId) as Record<string, unknown>[];
  },
  create(wp: { id: string; bot_id: string; name: string; x: number; y: number; z: number; dimension?: string; description?: string }) {
    getDatabase().prepare(
      "INSERT INTO waypoints (id, bot_id, name, x, y, z, dimension, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(wp.id, wp.bot_id, wp.name, wp.x, wp.y, wp.z, wp.dimension ?? "overworld", wp.description ?? null);
  },
  delete(id: string) {
    getDatabase().prepare("DELETE FROM waypoints WHERE id = ?").run(id);
  },
};

export const TaskHistoryRepo = {
  getByBot(botId: string, limit = 50) {
    return getDatabase().prepare("SELECT * FROM task_history WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?").all(botId, limit) as Record<string, unknown>[];
  },
  create(task: { id: string; bot_id: string; name: string; description?: string }) {
    getDatabase().prepare(
      "INSERT INTO task_history (id, bot_id, name, description) VALUES (?, ?, ?, ?)"
    ).run(task.id, task.bot_id, task.name, task.description ?? null);
  },
  update(id: string, data: { status: string; started_at?: number; finished_at?: number; error?: string }) {
    getDatabase().prepare(
      "UPDATE task_history SET status=?, started_at=?, finished_at=?, error=? WHERE id=?"
    ).run(data.status, data.started_at ?? null, data.finished_at ?? null, data.error ?? null, id);
  },
};

export const StructureRepo = {
  getByBot(botId: string) {
    return getDatabase().prepare("SELECT * FROM structures WHERE bot_id = ? ORDER BY discovered_at DESC").all(botId) as Record<string, unknown>[];
  },
  create(s: { id: string; bot_id: string; type: string; x: number; y: number; z: number; dimension?: string }) {
    getDatabase().prepare(
      "INSERT OR IGNORE INTO structures (id, bot_id, type, x, y, z, dimension) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(s.id, s.bot_id, s.type, s.x, s.y, s.z, s.dimension ?? "overworld");
  },
};

export const InventoryRepo = {
  saveSnapshot(botId: string, items: unknown[]) {
    const d = getDatabase();
    d.prepare("INSERT INTO inventory_snapshots (bot_id, snapshot) VALUES (?, ?)").run(botId, JSON.stringify(items));
    const old = d.prepare(
      "SELECT id FROM inventory_snapshots WHERE bot_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 10"
    ).all(botId) as { id: number }[];
    if (old.length) {
      d.prepare(`DELETE FROM inventory_snapshots WHERE id IN (${old.map(() => "?").join(",")})`).run(...old.map(r => r.id));
    }
  },
  getLatest(botId: string) {
    const row = getDatabase().prepare("SELECT snapshot FROM inventory_snapshots WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1").get(botId) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) : [];
  },
};
