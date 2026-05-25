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
import { initDatabase, IS_POSTGRES } from "./database/Database.js";
import { BotManager } from "./bot/BotManager.js";
import { startMemoryMonitor, getMemoryStats } from "./utils/memory.js";
import { DEFAULT_CONFIG } from "./config/defaults.js";
import { verifyToken, COOKIE_NAME } from "./lib/auth.js";
import { parseCommand } from "./commands/CommandParser.js";
import { startKeepalive } from "./utils/keepalive.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app: Express = express();
const httpServer = createServer(app);

// Trust the first proxy hop — required for Render, Railway, Fly.io, Nginx, etc.
// so express-rate-limit sees the real client IP from X-Forwarded-For.
const trustProxy = process.env["TRUST_PROXY"] ?? "1";
app.set("trust proxy", isNaN(Number(trustProxy)) ? trustProxy : Number(trustProxy));

export const io = new SocketIOServer(httpServer, {
  cors: { origin: "*" },
  transports: ["websocket", "polling"],
  path: "/api/socket.io/",
});

if (!IS_POSTGRES) initDatabase();
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
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Cache-Control", "no-store");
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
  const userData = socket.data["user"] as { userId: number; username: string } | undefined;

  // Join user-specific room so auth_code events route correctly
  if (userData?.userId) {
    const roomName = `user:${userData.userId}`;
    socket.join(roomName);
    logger.info({ socketId: socket.id, room: roomName }, "Socket joined user room");
  }

  socket.emit("bots:all", manager.getAllStats());

  socket.on("bot:command", async (data: { botId: string; raw?: string; command?: string; args?: string[]; amount?: number }) => {
    if (!isAdmin) { socket.emit("command:error", { error: "Access denied" }); return; }
    try {
      let result: string | undefined;
      if (data.raw) {
        const parsed = parseCommand(data.raw);
        if (!parsed) { socket.emit("command:error", { error: "Empty command" }); return; }
        result = await manager.getBot(data.botId)?.executeCommand(parsed.command, parsed.args, parsed.amount);
      } else {
        result = await manager.sendCommand(data.botId, data.command!, data.args, data.amount);
      }
      socket.emit("command:result", { botId: data.botId, result });
    } catch (err) {
      socket.emit("command:error", { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // User-scoped command (any authenticated user, for their own bots)
  socket.on("user:bot:command", async (data: { runtimeId: string; raw?: string; command?: string; args?: string[]; amount?: number }) => {
    if (!userData) { socket.emit("command:error", { error: "Not authenticated" }); return; }
    const bot = manager.getBot(data.runtimeId);
    if (!bot) { socket.emit("command:error", { error: "Bot not found or not running" }); return; }
    const ownerUserId = manager.getBotOwner(data.runtimeId);
    if (ownerUserId !== undefined && ownerUserId !== userData.userId) {
      socket.emit("command:error", { error: "Access denied" });
      return;
    }
    try {
      let result: string | undefined;
      if (data.raw) {
        const parsed = parseCommand(data.raw);
        if (!parsed) { socket.emit("command:error", { error: "Empty command" }); return; }
        result = await bot.executeCommand(parsed.command, parsed.args, parsed.amount);
      } else {
        result = await manager.sendCommand(data.runtimeId, data.command!, data.args, data.amount);
      }
      socket.emit("command:result", { botId: data.runtimeId, result });
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
manager.on("bot:task_done", (data) => io.emit("bot:task_done", data));
manager.on("bot:added",     ()     => io.emit("bots:all", manager.getAllStats()));
manager.on("bot:removed",   ()     => io.emit("bots:all", manager.getAllStats()));

// Start keep-alive self-ping (prevents free-tier sleep on Render/Railway/Fly)
startKeepalive();

// Stream auth_code events to the owning user's private Socket.io room
manager.on("bot:auth_code", (data: { id: string; userId?: number; url: string; code: string; expiresIn: number }) => {
  if (data.userId) {
    io.to(`user:${data.userId}`).emit("bot:auth_code", data);
    logger.info({ botId: data.id, userId: data.userId }, "Streamed auth_code to user room");
  } else {
    // Admin-managed bot — broadcast to all admin sockets
    io.emit("bot:auth_code", data);
  }
});

export { httpServer as default };
export { app };
