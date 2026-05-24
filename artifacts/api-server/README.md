# Minecraft AI Bot Platform

A production-ready, advanced Minecraft AI Bot platform built with Node.js, Mineflayer, Express, and Socket.io.

## Features

- **Multi-bot support** – run multiple bots across multiple servers simultaneously
- **Auto-reconnect** – smart exponential backoff reconnection after kicks, crashes, or network loss
- **Version auto-detection** – automatically detects and matches the server's Minecraft version (1.16–1.21+)
- **Web dashboard** – real-time control panel with live logs, inventory viewer, task queue, waypoints, and more
- **Plugin system** – modular architecture: Mining, Farming, Combat, Building, Exploration, Inventory
- **SQLite persistence** – saves waypoints, structures, task history, and inventory snapshots
- **Memory optimization** – GC hints, log rotation, async task queues
- **Crash recovery** – restores tasks and state on reconnect

## Quick Start

```bash
# 1. Install dependencies
npm install -g pnpm
pnpm install

# 2. Copy and edit environment config
cp .env.example .env

# 3. Build and run
pnpm run dev
```

Open http://localhost:3000 in your browser. Default password: `admin`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DASHBOARD_PASSWORD` | `admin` | Dashboard login password |
| `DATA_DIR` | `./data` | SQLite and data storage directory |
| `NODE_ENV` | `development` | Environment mode |

## Bot Commands

Commands work from both the web dashboard console and in-game chat (prefix with `!`):

| Command | Example | Description |
|---------|---------|-------------|
| `stop` | `!stop` | Stop all current tasks |
| `follow <player>` | `!follow Steve` | Follow a player |
| `mine <ore> <amount>` | `!mine diamond 32` | Mine specific ore |
| `collect <block> <amount>` | `!collect oak_log 64` | Collect blocks |
| `farm <crop>` | `!farm wheat` | Start farming loop |
| `craft <item> <amount>` | `!craft iron_pickaxe 1` | Craft items |
| `goto <x> <y> <z>` | `!goto 100 64 200` | Navigate to coordinates |
| `find <structure>` | `!find village` | Explore and find structure |
| `attack <mob>` | `!attack zombie` | Fight mobs |
| `defend [player]` | `!defend Steve` | Defend a player |
| `deposit` | `!deposit` | Deposit items to nearest chest |
| `organize` | `!organize` | Organize inventory |
| `build <structure>` | `!build house` | Build a structure |
| `waypoint save <name>` | `!waypoint save home` | Save current location |
| `waypoint goto <name>` | `!waypoint goto home` | Go to a saved waypoint |
| `status` | `!status` | Show bot status |

## Supported Minecraft Versions

1.16.x, 1.17.x, 1.18.x, 1.19.x, 1.20.x, 1.21.x

## Deployment

### Docker

```bash
docker compose up -d
```

### Render

Deploy using `render.yaml`. Set `DASHBOARD_PASSWORD` in environment variables.

### Railway

Set `PORT`, `DASHBOARD_PASSWORD`, and `DATA_DIR` environment variables. Run `pnpm install && pnpm run build` as build command and `node --enable-source-maps ./dist/index.mjs` as start command.

### VPS with PM2

```bash
pnpm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/bots` | List all bots |
| `POST` | `/api/bots` | Add a new bot |
| `GET` | `/api/bots/:id` | Get bot stats |
| `DELETE` | `/api/bots/:id` | Remove a bot |
| `POST` | `/api/bots/:id/connect` | Connect bot |
| `POST` | `/api/bots/:id/disconnect` | Disconnect bot |
| `POST` | `/api/bots/:id/command` | Send command `{ raw: "mine diamond 32" }` |
| `GET` | `/api/bots/:id/waypoints` | List waypoints |
| `GET` | `/api/bots/:id/tasks` | Get task queue |
| `POST` | `/api/bots/:id/tasks/stop` | Stop all tasks |
| `GET` | `/api/bots/:id/structures` | List discovered structures |
| `GET` | `/api/bots/:id/logs` | Get bot logs |

## Project Structure

```
src/
├── bot/            Bot engine (MinecraftBot, BotManager, version detection)
├── plugins/        Feature plugins (mining, farming, combat, building, exploration, inventory)
├── commands/       Command parsing system
├── database/       SQLite persistence layer
├── utils/          Task queue, memory monitor, helpers
├── config/         Default configuration and constants
├── routes/         Express API routes
└── web/            Dashboard HTML/JS

Dockerfile          Docker build
docker-compose.yml  Docker Compose
render.yaml         Render deployment
ecosystem.config.js PM2 configuration
.env.example        Environment template
```
