import express, { type Express } from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pinoHttp from "pino-http";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import { createServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { initDatabase } from "./database/Database.js";
import { BotManager } from "./bot/BotManager.js";
import { startMemoryMonitor, getMemoryStats } from "./utils/memory.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { verifyToken, COOKIE_NAME } from "./lib/auth.js";

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

// ─── Middleware ──────────────────────────────────────────────────────────────

app.use(pinoHttp({
  logger,
  serializers: {
    req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; },
    res(res) { return { statusCode: res.statusCode }; },
  },
}));

app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api", rateLimit({
  windowMs: DEFAULT_CONFIG.dashboard.rateLimit.windowMs,
  max: DEFAULT_CONFIG.dashboard.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ─── Static / Page Routes ───────────────────────────────────────────────────

const staticDir = path.join(__dirname, "web");

app.get(["/", "/api", "/api/"], (_req, res) => {
  res.sendFile(path.join(staticDir, "index.html"));
});

app.get(["/dashboard", "/api/dashboard", "/api/dashboard/"], (_req, res) => {
  res.sendFile(path.join(staticDir, "dashboard.html"));
});

app.get(["/admin", "/api/admin", "/api/admin/"], (_req, res) => {
  res.sendFile(path.join(staticDir, "admin.html"));
});

app.get(["/user", "/api/user", "/api/user/"], (_req, res) => {
  res.sendFile(path.join(staticDir, "user.html"));
});

app.use(express.static(staticDir));

// ─── API Routes ──────────────────────────────────────────────────────────────

app.use("/api", router);

// ─── Socket.io Auth ─────────────────────────────────────────────────────────

io.use((socket, next) => {
  const adminPass = socket.handshake.auth["password"] as string | undefined;
  const userToken = socket.handshake.auth["token"] as string | undefined;

  if (adminPass === DASHBOARD_PASSWORD) {
    authenticatedSockets.add(socket.id);
    socket.data["role"] = "admin";
  } else if (userToken) {
    const payload = verifyToken(userToken);
    if (payload) {
      socket.data["role"] = "user";
      socket.data["user"] = payload;
    } else {
      socket.data["role"] = "readonly";
    }
  } else {
    socket.data["role"] = "readonly";
  }
  next();
});

io.on("connection", (socket) => {
  logger.info({ socketId: socket.id, role: socket.data["role"] }, "Socket connected");

  const manager = BotManager.getInstance();
  const role = socket.data["role"] as string;
  const isAdmin = role === "admin";

  socket.emit("bots:all", manager.getAllStats());

  socket.on("bot:command", async (data: { botId: string; raw?: string; command?: string; args?: string[]; amount?: number }) => {
    if (!isAdmin) { socket.emit("command:error", { error: "Access denied" }); return; }
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
    if (!isAdmin) return;
    const bot = manager.addBot(config);
    socket.emit("bot:created", { id: bot.id });
    io.emit("bots:all", manager.getAllStats());
  });

  socket.on("bot:remove", (id: string) => {
    if (!isAdmin) return;
    manager.removeBot(id);
    io.emit("bots:all", manager.getAllStats());
  });

  socket.on("bot:connect", async (id: string) => {
    if (!isAdmin) return;
    await manager.connectBot(id).catch(() => {});
  });

  socket.on("bot:disconnect", (id: string) => {
    if (!isAdmin) return;
    manager.disconnectBot(id);
  });

  socket.on("memory:stats", () => {
    socket.emit("memory:stats", getMemoryStats());
  });

  socket.on("disconnect", () => {
    authenticatedSockets.delete(socket.id);
  });
});

// ─── Bot Event Broadcasts ────────────────────────────────────────────────────

const manager = BotManager.getInstance();
manager.on("bot:status",    (data) => io.emit("bot:status", data));
manager.on("bot:log",       (data) => io.emit("bot:log", data));
manager.on("bot:chat",      (data) => io.emit("bot:chat", data));
manager.on("bot:health",    (data) => io.emit("bot:health", data));
manager.on("bot:position",  (data) => io.emit("bot:position", data));
manager.on("bot:inventory", (data) => io.emit("bot:inventory", data));
manager.on("bot:tasks",     (data) => io.emit("bot:tasks", data));
manager.on("bot:added",     ()     => io.emit("bots:all", manager.getAllStats()));
manager.on("bot:removed",   ()     => io.emit("bots:all", manager.getAllStats()));

export { httpServer as default };
export { app };
