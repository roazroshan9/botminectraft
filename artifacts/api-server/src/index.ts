import { execSync } from "node:child_process";
import server from "./app.js";
import { logger } from "./lib/logger.js";
import { IS_POSTGRES } from "./database/Database.js";

// ─── Database setup ──────────────────────────────────────────────────────────
// For PostgreSQL: push Prisma schema to the database (idempotent, safe on every start)
// For SQLite:     tables are created automatically inside getSqliteDb()

if (IS_POSTGRES) {
  logger.info("PostgreSQL detected — skipping auto db push (schema already applied)");
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : 3000;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

server.listen(port, "0.0.0.0", () => {
  logger.info({ port, provider: IS_POSTGRES ? "postgresql" : "sqlite" }, "🤖 Minecraft AI Bot Platform listening");
  logger.info(`   Dashboard: http://localhost:${port}`);
  logger.info(`   API:       http://localhost:${port}/api/health`);
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully");
  process.exit(0);
});
