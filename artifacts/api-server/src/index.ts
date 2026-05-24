import server from "./app.js";
import { logger } from "./lib/logger.js";

const rawPort = process.env["PORT"];
const port = rawPort ? Number(rawPort) : 3000;

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

server.listen(port, "0.0.0.0", () => {
  logger.info({ port }, "🤖 Minecraft AI Bot Platform listening");
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
