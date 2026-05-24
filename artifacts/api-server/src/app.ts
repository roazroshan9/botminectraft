import express, { type Express } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { initDatabase } from "./database/Database.js";
import { BotManager } from "./bot/BotManager.js";
import { startMemoryMonitor, getMemoryStats } from "./utils/memory.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();
const httpServer = createServer(app);
export const io = new SocketIOServer(httpServer, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  path: "/api/socket.io/",
});

initDatabase();
startMemoryMonitor();

const DASHBOARD_PASSWORD = process.env["DASHBOARD_PASSWORD"] || "admin";
const authenticatedSockets = new Set<string>();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  "/api",
  rateLimit({
    windowMs: DEFAULT_CONFIG.dashboard.rateLimit.windowMs,
    max: DEFAULT_CONFIG.dashboard.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

const staticDir = path.join(__dirname, "web");

app.get(["/", "/api", "/api/"], (_req, res) => {
  res.sendFile(path.join(staticDir, "dashboard.html"));
});

app.use(express.static(staticDir));

app.use("/api", router);

io.use((socket, next) => {
  const pass = socket.handshake.auth["password"] as string | undefined;
  if (pass === DASHBOARD_PASSWORD || DASHBOARD_PASSWORD === "admin") {
    authenticatedSockets.add(socket.id);
    next();
  } else {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", (socket) => {
  logger.info({ socketId: socket.id }, "Dashboard connected");

  const manager = BotManager.getInstance();

  socket.emit("bots:all", manager.getAllStats());

  socket.on("bot:command", async (data: { botId: string; raw?: string; command?: string; args?: string[]; amount?: number }) => {
    try {
      const result = data.raw
        ? await manager.getBot(data.botId)?.executeCommand(data.raw.split(" ")[0]!, data.raw.split(" ").slice(1), undefined)
        : await manager.sendCommand(data.botId, data.command!, data.args, data.amount);
      socket.emit("command:result", { botId: data.botId, result });
    } catch (err) {
      socket.emit("command:error", { error: err instanceof Error ? err.message : String(err) });
    }
  });

  socket.on("bot:create", async (config) => {
    const bot = manager.addBot(config);
    socket.emit("bot:created", { id: bot.id });
    io.emit("bots:all", manager.getAllStats());
  });

  socket.on("bot:remove", (id: string) => {
    manager.removeBot(id);
    io.emit("bots:all", manager.getAllStats());
  });

  socket.on("bot:connect", async (id: string) => {
    await manager.connectBot(id).catch(() => {});
  });

  socket.on("bot:disconnect", (id: string) => {
    manager.disconnectBot(id);
  });

  socket.on("memory:stats", () => {
    socket.emit("memory:stats", getMemoryStats());
  });

  socket.on("disconnect", () => {
    authenticatedSockets.delete(socket.id);
  });
});

const manager = BotManager.getInstance();

manager.on("bot:status", (data) => io.emit("bot:status", data));
manager.on("bot:log",    (data) => io.emit("bot:log", data));
manager.on("bot:chat",   (data) => io.emit("bot:chat", data));
manager.on("bot:health", (data) => io.emit("bot:health", data));
manager.on("bot:position",(data) => io.emit("bot:position", data));
manager.on("bot:inventory",(data) => io.emit("bot:inventory", data));
manager.on("bot:tasks",  (data) => io.emit("bot:tasks", data));
manager.on("bot:added",  ()     => io.emit("bots:all", manager.getAllStats()));
manager.on("bot:removed",()     => io.emit("bots:all", manager.getAllStats()));

export { httpServer as default };
export { app };
