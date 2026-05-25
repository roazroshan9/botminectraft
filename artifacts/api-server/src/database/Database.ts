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
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    -- ═══════════════════════════════════════════
    -- LEGACY TABLES (kept for backward compat)
    -- ═══════════════════════════════════════════
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

    -- ═══════════════════════════════════════════
    -- SAAS TABLES
    -- ═══════════════════════════════════════════

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      tier          TEXT    NOT NULL DEFAULT 'free',
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount         REAL    NOT NULL,
      currency       TEXT    NOT NULL DEFAULT 'USD',
      status         TEXT    NOT NULL DEFAULT 'pending',
      transaction_id TEXT,
      tier_granted   TEXT    NOT NULL,
      timestamp      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_bots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bot_name       TEXT    NOT NULL,
      server_ip      TEXT    NOT NULL,
      server_port    INTEGER NOT NULL DEFAULT 25565,
      mc_version     TEXT    NOT NULL DEFAULT 'auto',
      auth_type      TEXT    NOT NULL DEFAULT 'offline',
      auth_data_json TEXT,
      status         TEXT    NOT NULL DEFAULT 'offline',
      current_task   TEXT,
      runtime_id     TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS live_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id     INTEGER NOT NULL REFERENCES user_bots(id) ON DELETE CASCADE,
      log_type   TEXT    NOT NULL DEFAULT 'info',
      message    TEXT    NOT NULL,
      timestamp  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS support_messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender    TEXT    NOT NULL DEFAULT 'user',
      message   TEXT    NOT NULL,
      is_read   INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT    NOT NULL,
      expires_at TEXT    NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_user_bots_user_id   ON user_bots(user_id);
    CREATE INDEX IF NOT EXISTS idx_live_logs_bot_id    ON live_logs(bot_id);
    CREATE INDEX IF NOT EXISTS idx_support_user_id     ON support_messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_user_id    ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_prt_user_id         ON password_reset_tokens(user_id);
  `);

  logger.info({ path: DB_PATH }, "Database initialized (SaaS schema v2)");
  return db;
}

export function getDatabase(): DatabaseSync {
  if (!db) initDatabase();
  return db;
}

// ─── Legacy Repos ───────────────────────────────────────────────────────────

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

// ─── SaaS Repos ─────────────────────────────────────────────────────────────

type UserRow = {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  tier: string;
  is_active: number;
  created_at: string;
};

export const UserRepo = {
  getById(id: number): UserRow | undefined {
    return getDatabase().prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  },
  getByEmail(email: string): UserRow | undefined {
    return getDatabase().prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email) as UserRow | undefined;
  },
  getByUsername(username: string): UserRow | undefined {
    return getDatabase().prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as UserRow | undefined;
  },
  getAll(): UserRow[] {
    return getDatabase().prepare("SELECT id, username, email, tier, is_active, created_at FROM users ORDER BY created_at DESC").all() as UserRow[];
  },
  create(data: { username: string; email: string; passwordHash: string }): UserRow {
    const db = getDatabase();
    db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)")
      .run(data.username, data.email, data.passwordHash);
    return db.prepare("SELECT * FROM users WHERE email = ?").get(data.email) as UserRow;
  },
  setTier(id: number, tier: string) {
    getDatabase().prepare("UPDATE users SET tier = ? WHERE id = ?").run(tier, id);
  },
  setActive(id: number, active: boolean) {
    getDatabase().prepare("UPDATE users SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
  },
  resetPassword(id: number, passwordHash: string) {
    getDatabase().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  },
  count(): number {
    return (getDatabase().prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
  },
};

type PasswordResetRow = {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: string;
  used: number;
};

export const PasswordResetRepo = {
  create(userId: number, tokenHash: string): void {
    const db = getDatabase();
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(userId);
    db.prepare(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))"
    ).run(userId, tokenHash);
  },
  findValid(userId: number, tokenHash: string): PasswordResetRow | undefined {
    return getDatabase().prepare(
      "SELECT * FROM password_reset_tokens WHERE user_id = ? AND token_hash = ? AND used = 0 AND expires_at > datetime('now')"
    ).get(userId, tokenHash) as PasswordResetRow | undefined;
  },
  markUsed(id: number): void {
    getDatabase().prepare("UPDATE password_reset_tokens SET used = 1 WHERE id = ?").run(id);
  },
};

type PaymentRow = {
  id: number;
  user_id: number;
  amount: number;
  currency: string;
  status: string;
  transaction_id: string | null;
  tier_granted: string;
  timestamp: string;
};

export const PaymentRepo = {
  getByUser(userId: number): PaymentRow[] {
    return getDatabase().prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY timestamp DESC").all(userId) as PaymentRow[];
  },
  create(data: { userId: number; amount: number; tierGranted: string; transactionId?: string; status?: string }): PaymentRow {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO payments (user_id, amount, tier_granted, transaction_id, status) VALUES (?, ?, ?, ?, ?)"
    ).run(data.userId, data.amount, data.tierGranted, data.transactionId ?? null, data.status ?? "pending");
    return db.prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(data.userId) as PaymentRow;
  },
  updateStatus(id: number, status: string, transactionId?: string) {
    getDatabase().prepare("UPDATE payments SET status = ?, transaction_id = COALESCE(?, transaction_id) WHERE id = ?")
      .run(status, transactionId ?? null, id);
  },
};

type UserBotRow = {
  id: number;
  user_id: number;
  bot_name: string;
  server_ip: string;
  server_port: number;
  mc_version: string;
  auth_type: string;
  auth_data_json: string | null;
  status: string;
  current_task: string | null;
  runtime_id: string | null;
  created_at: string;
};

export const UserBotRepo = {
  getByUser(userId: number): UserBotRow[] {
    return getDatabase().prepare(
      "SELECT * FROM user_bots WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC"
    ).all(userId) as UserBotRow[];
  },
  getById(id: number): UserBotRow | undefined {
    return getDatabase().prepare("SELECT * FROM user_bots WHERE id = ?").get(id) as UserBotRow | undefined;
  },
  getAll(): UserBotRow[] {
    return getDatabase().prepare(
      "SELECT ub.*, u.username FROM user_bots ub JOIN users u ON ub.user_id = u.id WHERE ub.status != 'deleted' ORDER BY ub.created_at DESC"
    ).all() as UserBotRow[];
  },
  create(data: { userId: number; botName: string; serverIp: string; serverPort?: number; mcVersion?: string; authType?: string }): UserBotRow {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO user_bots (user_id, bot_name, server_ip, server_port, mc_version, auth_type) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(data.userId, data.botName, data.serverIp, data.serverPort ?? 25565, data.mcVersion ?? "auto", data.authType ?? "offline");
    return db.prepare("SELECT * FROM user_bots WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(data.userId) as UserBotRow;
  },
  updateStatus(id: number, status: string, currentTask?: string | null, runtimeId?: string | null) {
    getDatabase().prepare("UPDATE user_bots SET status = ?, current_task = ?, runtime_id = ? WHERE id = ?")
      .run(status, currentTask ?? null, runtimeId ?? null, id);
  },
  saveAuthData(id: number, authDataJson: string) {
    getDatabase().prepare("UPDATE user_bots SET auth_data_json = ? WHERE id = ?").run(authDataJson, id);
  },
  delete(id: number) {
    getDatabase().prepare("UPDATE user_bots SET status = 'deleted' WHERE id = ?").run(id);
  },
  countByUser(userId: number): number {
    return (getDatabase().prepare(
      "SELECT COUNT(*) as c FROM user_bots WHERE user_id = ? AND status != 'deleted'"
    ).get(userId) as { c: number }).c;
  },
};

type LiveLogRow = {
  id: number;
  bot_id: number;
  log_type: string;
  message: string;
  timestamp: string;
};

export const LiveLogRepo = {
  getByBot(botId: number, limit = 100): LiveLogRow[] {
    return getDatabase().prepare(
      "SELECT * FROM live_logs WHERE bot_id = ? ORDER BY id DESC LIMIT ?"
    ).all(botId, limit) as LiveLogRow[];
  },
  insert(botId: number, message: string, logType = "info") {
    const db = getDatabase();
    db.prepare("INSERT INTO live_logs (bot_id, log_type, message) VALUES (?, ?, ?)").run(botId, logType, message);
    const old = db.prepare(
      "SELECT id FROM live_logs WHERE bot_id = ? ORDER BY id DESC LIMIT -1 OFFSET 5000"
    ).all(botId) as { id: number }[];
    if (old.length) {
      db.prepare(`DELETE FROM live_logs WHERE id IN (${old.map(() => "?").join(",")})`).run(...old.map(r => r.id));
    }
  },
};

type SupportMessageRow = {
  id: number;
  user_id: number;
  sender: string;
  message: string;
  is_read: number;
  timestamp: string;
};

export const SupportRepo = {
  getThreadsByUser(userId: number): SupportMessageRow[] {
    return getDatabase().prepare(
      "SELECT * FROM support_messages WHERE user_id = ? ORDER BY timestamp ASC"
    ).all(userId) as SupportMessageRow[];
  },
  getAllThreads() {
    return getDatabase().prepare(`
      SELECT sm.*, u.username FROM support_messages sm
      JOIN users u ON sm.user_id = u.id
      ORDER BY sm.timestamp DESC
    `).all() as (SupportMessageRow & { username: string })[];
  },
  getUnreadCount(): number {
    return (getDatabase().prepare(
      "SELECT COUNT(*) as c FROM support_messages WHERE sender = 'user' AND is_read = 0"
    ).get() as { c: number }).c;
  },
  insert(userId: number, message: string, sender: "user" | "admin"): SupportMessageRow {
    const db = getDatabase();
    db.prepare("INSERT INTO support_messages (user_id, sender, message) VALUES (?, ?, ?)").run(userId, sender, message);
    return db.prepare("SELECT * FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId) as SupportMessageRow;
  },
  markRead(userId: number) {
    getDatabase().prepare(
      "UPDATE support_messages SET is_read = 1 WHERE user_id = ? AND sender = 'user'"
    ).run(userId);
  },
};
