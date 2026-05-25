import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../lib/logger.js";
import { getPrismaClient } from "./prismaClient.js";

// ─── Provider detection ──────────────────────────────────────────────────────

export const IS_POSTGRES = (process.env["DATABASE_URL"] ?? "").startsWith("postgres");

// ─── Shared record types ──────────────────────────────────────────────────────

export type UserRecord = {
  id: number;
  username: string;
  email: string;
  password_hash: string;
  tier: string;
  is_active: boolean;
  created_at: Date | string;
};

export type UserBotRecord = {
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
  created_at: Date | string;
};

export type LiveLogRecord = {
  id: number;
  bot_id: number;
  log_type: string;
  message: string;
  timestamp: Date | string;
};

export type SupportMessageRecord = {
  id: number;
  user_id: number;
  sender: string;
  message: string;
  is_read: boolean;
  timestamp: Date | string;
  username?: string;
};

export type PaymentRecord = {
  id: number;
  user_id: number;
  amount: number;
  currency: string;
  status: string;
  transaction_id: string | null;
  tier_granted: string;
  timestamp: Date | string;
  username?: string;
};

export type PasswordResetRecord = {
  id: number;
  user_id: number;
  token_hash: string;
  expires_at: Date | string;
  used: boolean;
};

// ─── SQLite setup (used when IS_POSTGRES is false) ───────────────────────────

const DB_DIR = process.env["DATA_DIR"] || path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "mcbot.db");

let _sqliteDb: DatabaseSync | undefined;

function getSqliteDb(): DatabaseSync {
  if (_sqliteDb) return _sqliteDb;
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  _sqliteDb = new DatabaseSync(DB_PATH);
  initSqliteTables(_sqliteDb);
  logger.info({ path: DB_PATH }, "SQLite database initialized");
  return _sqliteDb;
}

function initSqliteTables(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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
      x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
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
      started_at INTEGER, finished_at INTEGER, error TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS structures (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      type TEXT NOT NULL,
      x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL,
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

    CREATE INDEX IF NOT EXISTS idx_user_bots_user_id ON user_bots(user_id);
    CREATE INDEX IF NOT EXISTS idx_live_logs_bot_id  ON live_logs(bot_id);
    CREATE INDEX IF NOT EXISTS idx_support_user_id   ON support_messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_user_id  ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_prt_user_id       ON password_reset_tokens(user_id);
  `);
}

// Exported for legacy bot repos (BotManager / MinecraftBot)
export function initDatabase() { return getSqliteDb(); }
export function getDatabase(): DatabaseSync { return getSqliteDb(); }

// SQLite boolean normalizers
function normUser(row: Record<string, unknown>): UserRecord {
  return { ...(row as UserRecord), is_active: !!row["is_active"] };
}
function normSupport(row: Record<string, unknown>): SupportMessageRecord {
  return { ...(row as SupportMessageRecord), is_read: !!row["is_read"] };
}
function normPrt(row: Record<string, unknown>): PasswordResetRecord {
  return { ...(row as PasswordResetRecord), used: !!row["used"] };
}

// ─── Legacy bot repos (SQLite-only, synchronous) ──────────────────────────────

export const BotRepo = {
  getAll() {
    return getSqliteDb().prepare("SELECT * FROM bots ORDER BY created_at DESC").all() as Record<string, unknown>[];
  },
  getById(id: string) {
    return getSqliteDb().prepare("SELECT * FROM bots WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  },
  create(bot: { id: string; username: string; host: string; port: number; version: string; auth: string; password?: string }) {
    getSqliteDb().prepare(
      "INSERT INTO bots (id, username, host, port, version, auth, password) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(bot.id, bot.username, bot.host, bot.port, bot.version, bot.auth, bot.password ?? null);
  },
  update(id: string, data: Partial<{ username: string; host: string; port: number; version: string; enabled: number }>) {
    const fields = Object.keys(data).map(k => `${k} = ?`).join(", ");
    getSqliteDb().prepare(`UPDATE bots SET ${fields}, updated_at = unixepoch() WHERE id = ?`)
      .run(...Object.values(data), id);
  },
  delete(id: string) {
    getSqliteDb().prepare("DELETE FROM bots WHERE id = ?").run(id);
  },
};

export const WaypointRepo = {
  getByBot(botId: string) {
    return getSqliteDb().prepare("SELECT * FROM waypoints WHERE bot_id = ? ORDER BY created_at DESC").all(botId) as Record<string, unknown>[];
  },
  create(wp: { id: string; bot_id: string; name: string; x: number; y: number; z: number; dimension?: string; description?: string }) {
    getSqliteDb().prepare(
      "INSERT INTO waypoints (id, bot_id, name, x, y, z, dimension, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(wp.id, wp.bot_id, wp.name, wp.x, wp.y, wp.z, wp.dimension ?? "overworld", wp.description ?? null);
  },
  delete(id: string) {
    getSqliteDb().prepare("DELETE FROM waypoints WHERE id = ?").run(id);
  },
};

export const TaskHistoryRepo = {
  getByBot(botId: string, limit = 50) {
    return getSqliteDb().prepare("SELECT * FROM task_history WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?").all(botId, limit) as Record<string, unknown>[];
  },
  create(task: { id: string; bot_id: string; name: string; description?: string }) {
    getSqliteDb().prepare(
      "INSERT INTO task_history (id, bot_id, name, description) VALUES (?, ?, ?, ?)"
    ).run(task.id, task.bot_id, task.name, task.description ?? null);
  },
  update(id: string, data: { status: string; started_at?: number; finished_at?: number; error?: string }) {
    getSqliteDb().prepare(
      "UPDATE task_history SET status=?, started_at=?, finished_at=?, error=? WHERE id=?"
    ).run(data.status, data.started_at ?? null, data.finished_at ?? null, data.error ?? null, id);
  },
};

export const StructureRepo = {
  getByBot(botId: string) {
    return getSqliteDb().prepare("SELECT * FROM structures WHERE bot_id = ? ORDER BY discovered_at DESC").all(botId) as Record<string, unknown>[];
  },
  create(s: { id: string; bot_id: string; type: string; x: number; y: number; z: number; dimension?: string }) {
    getSqliteDb().prepare(
      "INSERT OR IGNORE INTO structures (id, bot_id, type, x, y, z, dimension) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(s.id, s.bot_id, s.type, s.x, s.y, s.z, s.dimension ?? "overworld");
  },
};

export const InventoryRepo = {
  saveSnapshot(botId: string, items: unknown[]) {
    const d = getSqliteDb();
    d.prepare("INSERT INTO inventory_snapshots (bot_id, snapshot) VALUES (?, ?)").run(botId, JSON.stringify(items));
    const old = d.prepare(
      "SELECT id FROM inventory_snapshots WHERE bot_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 10"
    ).all(botId) as { id: number }[];
    if (old.length) {
      d.prepare(`DELETE FROM inventory_snapshots WHERE id IN (${old.map(() => "?").join(",")})`).run(...old.map(r => r.id));
    }
  },
  getLatest(botId: string) {
    const row = getSqliteDb().prepare("SELECT snapshot FROM inventory_snapshots WHERE bot_id = ? ORDER BY created_at DESC LIMIT 1").get(botId) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) : [];
  },
};

// ─── SaaS repos (async, dual-adapter: SQLite ↔ PostgreSQL/Prisma) ─────────────

export const UserRepo = {
  async getById(id: number): Promise<UserRecord | null> {
    if (IS_POSTGRES) {
      return getPrismaClient().user.findUnique({ where: { id } });
    }
    const row = getSqliteDb().prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? normUser(row) : null;
  },

  async getByEmail(email: string): Promise<UserRecord | null> {
    if (IS_POSTGRES) {
      return getPrismaClient().user.findFirst({ where: { email: email.toLowerCase() } });
    }
    const row = getSqliteDb().prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email) as Record<string, unknown> | undefined;
    return row ? normUser(row) : null;
  },

  async getByUsername(username: string): Promise<UserRecord | null> {
    if (IS_POSTGRES) {
      return getPrismaClient().user.findFirst({ where: { username: { equals: username, mode: "insensitive" } } });
    }
    const row = getSqliteDb().prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username) as Record<string, unknown> | undefined;
    return row ? normUser(row) : null;
  },

  async getAll(): Promise<UserRecord[]> {
    if (IS_POSTGRES) {
      const rows = await getPrismaClient().user.findMany({ orderBy: { created_at: "desc" } });
      return rows as UserRecord[];
    }
    const rows = getSqliteDb().prepare("SELECT id, username, email, tier, is_active, created_at FROM users ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return rows.map(normUser);
  },

  async getRecent(limit: number): Promise<Partial<UserRecord>[]> {
    if (IS_POSTGRES) {
      return getPrismaClient().user.findMany({
        take: limit,
        orderBy: { created_at: "desc" },
        select: { id: true, username: true, email: true, tier: true, created_at: true },
      });
    }
    return getSqliteDb().prepare(
      "SELECT id, username, email, tier, created_at FROM users ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as Partial<UserRecord>[];
  },

  async create(data: { username: string; email: string; passwordHash: string }): Promise<UserRecord> {
    if (IS_POSTGRES) {
      const user = await getPrismaClient().user.create({
        data: { username: data.username, email: data.email.toLowerCase(), password_hash: data.passwordHash },
      });
      return user as UserRecord;
    }
    const db = getSqliteDb();
    db.prepare("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)")
      .run(data.username, data.email.toLowerCase(), data.passwordHash);
    return normUser(db.prepare("SELECT * FROM users WHERE email = ?").get(data.email.toLowerCase()) as Record<string, unknown>);
  },

  async setTier(id: number, tier: string): Promise<void> {
    if (IS_POSTGRES) { await getPrismaClient().user.update({ where: { id }, data: { tier } }); return; }
    getSqliteDb().prepare("UPDATE users SET tier = ? WHERE id = ?").run(tier, id);
  },

  async setActive(id: number, active: boolean): Promise<void> {
    if (IS_POSTGRES) { await getPrismaClient().user.update({ where: { id }, data: { is_active: active } }); return; }
    getSqliteDb().prepare("UPDATE users SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
  },

  async resetPassword(id: number, passwordHash: string): Promise<void> {
    if (IS_POSTGRES) { await getPrismaClient().user.update({ where: { id }, data: { password_hash: passwordHash } }); return; }
    getSqliteDb().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  },

  async count(): Promise<number> {
    if (IS_POSTGRES) return getPrismaClient().user.count();
    return (getSqliteDb().prepare("SELECT COUNT(*) as c FROM users").get() as { c: number }).c;
  },
};

export const PasswordResetRepo = {
  async create(userId: number, tokenHash: string): Promise<void> {
    if (IS_POSTGRES) {
      const prisma = getPrismaClient();
      await prisma.$transaction([
        prisma.passwordResetToken.deleteMany({ where: { user_id: userId } }),
        prisma.passwordResetToken.create({
          data: { user_id: userId, token_hash: tokenHash, expires_at: new Date(Date.now() + 15 * 60 * 1000) },
        }),
      ]);
      return;
    }
    const db = getSqliteDb();
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(userId);
    db.prepare(
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '+15 minutes'))"
    ).run(userId, tokenHash);
  },

  async findValid(userId: number, tokenHash: string): Promise<PasswordResetRecord | null> {
    if (IS_POSTGRES) {
      const row = await getPrismaClient().passwordResetToken.findFirst({
        where: { user_id: userId, token_hash: tokenHash, used: false, expires_at: { gt: new Date() } },
      });
      return row as PasswordResetRecord | null;
    }
    const row = getSqliteDb().prepare(
      "SELECT * FROM password_reset_tokens WHERE user_id = ? AND token_hash = ? AND used = 0 AND expires_at > datetime('now')"
    ).get(userId, tokenHash) as Record<string, unknown> | undefined;
    return row ? normPrt(row) : null;
  },

  async markUsed(id: number): Promise<void> {
    if (IS_POSTGRES) { await getPrismaClient().passwordResetToken.update({ where: { id }, data: { used: true } }); return; }
    getSqliteDb().prepare("UPDATE password_reset_tokens SET used = 1 WHERE id = ?").run(id);
  },
};

export const PaymentRepo = {
  async getByUser(userId: number): Promise<PaymentRecord[]> {
    if (IS_POSTGRES) {
      const rows = await getPrismaClient().payment.findMany({ where: { user_id: userId }, orderBy: { timestamp: "desc" } });
      return rows as PaymentRecord[];
    }
    return getSqliteDb().prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY timestamp DESC").all(userId) as PaymentRecord[];
  },

  async create(data: { userId: number; amount: number; tierGranted: string; transactionId?: string; status?: string }): Promise<PaymentRecord> {
    if (IS_POSTGRES) {
      const row = await getPrismaClient().payment.create({
        data: {
          user_id: data.userId,
          amount: data.amount,
          tier_granted: data.tierGranted,
          transaction_id: data.transactionId ?? null,
          status: data.status ?? "pending",
        },
      });
      return row as PaymentRecord;
    }
    const db = getSqliteDb();
    db.prepare(
      "INSERT INTO payments (user_id, amount, tier_granted, transaction_id, status) VALUES (?, ?, ?, ?, ?)"
    ).run(data.userId, data.amount, data.tierGranted, data.transactionId ?? null, data.status ?? "pending");
    return db.prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(data.userId) as PaymentRecord;
  },

  async updateStatus(id: number, status: string, transactionId?: string): Promise<void> {
    if (IS_POSTGRES) {
      await getPrismaClient().payment.update({ where: { id }, data: { status, ...(transactionId ? { transaction_id: transactionId } : {}) } });
      return;
    }
    getSqliteDb().prepare("UPDATE payments SET status = ?, transaction_id = COALESCE(?, transaction_id) WHERE id = ?")
      .run(status, transactionId ?? null, id);
  },

  async getRevenue(): Promise<number> {
    if (IS_POSTGRES) {
      const r = await getPrismaClient().payment.aggregate({ where: { status: "completed" }, _sum: { amount: true } });
      return r._sum.amount ?? 0;
    }
    return (getSqliteDb().prepare("SELECT COALESCE(SUM(amount),0) as total FROM payments WHERE status='completed'").get() as { total: number }).total;
  },

  async getMrr(): Promise<number> {
    if (IS_POSTGRES) {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const r = await getPrismaClient().payment.aggregate({ where: { status: "completed", timestamp: { gte: since } }, _sum: { amount: true } });
      return r._sum.amount ?? 0;
    }
    return (getSqliteDb().prepare(
      "SELECT COALESCE(SUM(amount),0) as mrr FROM payments WHERE status='completed' AND timestamp >= date('now','-30 days')"
    ).get() as { mrr: number }).mrr;
  },

  async getRecentWithUser(limit: number): Promise<PaymentRecord[]> {
    if (IS_POSTGRES) {
      const rows = await getPrismaClient().payment.findMany({
        take: limit,
        orderBy: { timestamp: "desc" },
        include: { user: { select: { username: true } } },
      });
      return rows.map(r => ({ ...(r as PaymentRecord), username: r.user.username }));
    }
    return getSqliteDb().prepare(
      "SELECT p.*, u.username FROM payments p JOIN users u ON p.user_id = u.id ORDER BY p.timestamp DESC LIMIT ?"
    ).all(limit) as PaymentRecord[];
  },
};

export const UserBotRepo = {
  async getByUser(userId: number): Promise<UserBotRecord[]> {
    if (IS_POSTGRES) {
      const rows = await getPrismaClient().userBot.findMany({
        where: { user_id: userId, status: { not: "deleted" } },
        orderBy: { created_at: "desc" },
      });
      return rows as UserBotRecord[];
    }
    return getSqliteDb().prepare(
      "SELECT * FROM user_bots WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC"
    ).all(userId) as UserBotRecord[];
  },

  async getById(id: number): Promise<UserBotRecord | null> {
    if (IS_POSTGRES) {
      return getPrismaClient().userBot.findUnique({ where: { id } }) as Promise<UserBotRecord | null>;
    }
    return getSqliteDb().prepare("SELECT * FROM user_bots WHERE id = ?").get(id) as UserBotRecord | null;
  },

  async getAll(): Promise<(UserBotRecord & { ownerUsername?: string })[]> {
    if (IS_POSTGRES) {
      const rows = await getPrismaClient().userBot.findMany({
        where: { status: { not: "deleted" } },
        orderBy: { created_at: "desc" },
        include: { user: { select: { username: true } } },
      });
      return rows.map(r => ({ ...(r as UserBotRecord), ownerUsername: r.user.username }));
    }
    return getSqliteDb().prepare(
      "SELECT ub.*, u.username as ownerUsername FROM user_bots ub JOIN users u ON ub.user_id = u.id WHERE ub.status != 'deleted' ORDER BY ub.created_at DESC"
    ).all() as (UserBotRecord & { ownerUsername: string })[];
  },

  async create(data: { userId: number; botName: string; serverIp: string; serverPort?: number; mcVersion?: string; authType?: string }): Promise<UserBotRecord> {
    if (IS_POSTGRES) {
      const row = await getPrismaClient().userBot.create({
        data: {
          user_id: data.userId,
          bot_name: data.botName,
          server_ip: data.serverIp,
          server_port: data.serverPort ?? 25565,
          mc_version: data.mcVersion ?? "auto",
          auth_type: data.authType ?? "offline",
        },
      });
      return row as UserBotRecord;
    }
    const db = getSqliteDb();
    db.prepare(
      "INSERT INTO user_bots (user_id, bot_name, server_ip, server_port, mc_version, auth_type) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(data.userId, data.botName, data.serverIp, data.serverPort ?? 25565, data.mcVersion ?? "auto", data.authType ?? "offline");
    return db.prepare("SELECT * FROM user_bots WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(data.userId) as UserBotRecord;
  },

  async updateStatus(id: number, status: string, currentTask?: string | null, runtimeId?: string | null): Promise<void> {
    if (IS_POSTGRES) {
      await getPrismaClient().userBot.update({ where: { id }, data: { status, current_task: currentTask ?? null, runtime_id: runtimeId ?? null } });
      return;
    }
    getSqliteDb().prepare("UPDATE user_bots SET status = ?, current_task = ?, runtime_id = ? WHERE id = ?")
      .run(status, currentTask ?? null, runtimeId ?? null, id);
  },

  async saveAuthData(id: number, authDataJson: string): Promise<void> {
    if (IS_POSTGRES) { await getPrismaClient().userBot.update({ where: { id }, data: { auth_data_json: authDataJson } }); return; }
    getSqliteDb().prepare("UPDATE user_bots SET auth_data_json = ? WHERE id = ?").run(authDataJson, id);
  },

  async delete(id: number): Promise<void> {
    if (IS_POSTGRES) { await getPrismaClient().userBot.update({ where: { id }, data: { status: "deleted" } }); return; }
    getSqliteDb().prepare("UPDATE user_bots SET status = 'deleted' WHERE id = ?").run(id);
  },

  async countByUser(userId: number): Promise<number> {
    if (IS_POSTGRES) {
      return getPrismaClient().userBot.count({ where: { user_id: userId, status: { not: "deleted" } } });
    }
    return (getSqliteDb().prepare(
      "SELECT COUNT(*) as c FROM user_bots WHERE user_id = ? AND status != 'deleted'"
    ).get(userId) as { c: number }).c;
  },
};

export const LiveLogRepo = {
  async getByBot(botId: number, limit = 100): Promise<LiveLogRecord[]> {
    if (IS_POSTGRES) {
      const rows = await getPrismaClient().liveLog.findMany({
        where: { bot_id: botId },
        orderBy: { id: "desc" },
        take: limit,
      });
      return rows as LiveLogRecord[];
    }
    return getSqliteDb().prepare(
      "SELECT * FROM live_logs WHERE bot_id = ? ORDER BY id DESC LIMIT ?"
    ).all(botId, limit) as LiveLogRecord[];
  },

  async insert(botId: number, message: string, logType = "info"): Promise<void> {
    if (IS_POSTGRES) {
      const prisma = getPrismaClient();
      await prisma.liveLog.create({ data: { bot_id: botId, message, log_type: logType } });
      const keep = await prisma.liveLog.findMany({
        where: { bot_id: botId },
        orderBy: { id: "desc" },
        skip: 5000,
        select: { id: true },
      });
      if (keep.length) {
        await prisma.liveLog.deleteMany({ where: { id: { in: keep.map(r => r.id) } } });
      }
      return;
    }
    const db = getSqliteDb();
    db.prepare("INSERT INTO live_logs (bot_id, log_type, message) VALUES (?, ?, ?)").run(botId, logType, message);
    const old = db.prepare(
      "SELECT id FROM live_logs WHERE bot_id = ? ORDER BY id DESC LIMIT -1 OFFSET 5000"
    ).all(botId) as { id: number }[];
    if (old.length) {
      db.prepare(`DELETE FROM live_logs WHERE id IN (${old.map(() => "?").join(",")})`).run(...old.map(r => r.id));
    }
  },
};

export const SupportRepo = {
  async getThreadsByUser(userId: number): Promise<SupportMessageRecord[]> {
    if (IS_POSTGRES) {
      const rows = await getPrismaClient().supportMessage.findMany({
        where: { user_id: userId },
        orderBy: { timestamp: "asc" },
      });
      return rows.map(r => ({ ...(r as SupportMessageRecord) }));
    }
    const rows = getSqliteDb().prepare(
      "SELECT * FROM support_messages WHERE user_id = ? ORDER BY timestamp ASC"
    ).all(userId) as Record<string, unknown>[];
    return rows.map(normSupport);
  },

  async getAllThreads(): Promise<SupportMessageRecord[]> {
    if (IS_POSTGRES) {
      const rows = await getPrismaClient().supportMessage.findMany({
        orderBy: { timestamp: "desc" },
        include: { user: { select: { username: true } } },
      });
      return rows.map(r => ({ ...(r as SupportMessageRecord), username: r.user.username }));
    }
    const rows = getSqliteDb().prepare(`
      SELECT sm.*, u.username FROM support_messages sm
      JOIN users u ON sm.user_id = u.id
      ORDER BY sm.timestamp DESC
    `).all() as Record<string, unknown>[];
    return rows.map(r => ({ ...normSupport(r), username: r["username"] as string }));
  },

  async getUnreadCount(): Promise<number> {
    if (IS_POSTGRES) {
      return getPrismaClient().supportMessage.count({ where: { sender: "user", is_read: false } });
    }
    return (getSqliteDb().prepare(
      "SELECT COUNT(*) as c FROM support_messages WHERE sender = 'user' AND is_read = 0"
    ).get() as { c: number }).c;
  },

  async insert(userId: number, message: string, sender: "user" | "admin"): Promise<SupportMessageRecord> {
    if (IS_POSTGRES) {
      const row = await getPrismaClient().supportMessage.create({
        data: { user_id: userId, message, sender },
      });
      return row as SupportMessageRecord;
    }
    const db = getSqliteDb();
    db.prepare("INSERT INTO support_messages (user_id, sender, message) VALUES (?, ?, ?)").run(userId, sender, message);
    return normSupport(db.prepare("SELECT * FROM support_messages WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(userId) as Record<string, unknown>);
  },

  async markRead(userId: number): Promise<void> {
    if (IS_POSTGRES) {
      await getPrismaClient().supportMessage.updateMany({ where: { user_id: userId, sender: "user" }, data: { is_read: true } });
      return;
    }
    getSqliteDb().prepare(
      "UPDATE support_messages SET is_read = 1 WHERE user_id = ? AND sender = 'user'"
    ).run(userId);
  },
};
