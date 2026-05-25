# ─────────────────────────────────────────────────────────────────────────────
# CraftBot — Multi-stage Monorepo Dockerfile
# Build context: repository root
#   docker build -t craftbot -f Dockerfile .
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /workspace

# Build tools required by native add-ons (mineflayer, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm (pin major version for reproducibility)
RUN npm install -g pnpm@9

# ── Copy workspace manifest files first (layer-cache friendly) ────────────────
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml \
     tsconfig.base.json tsconfig.json ./

# Copy shared lib packages consumed by api-server
COPY lib/api-zod    ./lib/api-zod
COPY lib/db         ./lib/db
COPY lib/api-spec   ./lib/api-spec

# Copy the api-server artifact
COPY artifacts/api-server ./artifacts/api-server

# Install ALL deps (dev deps needed by esbuild at build time)
RUN pnpm install --frozen-lockfile

# Build the api-server (esbuild bundles everything → dist/index.mjs)
RUN pnpm --filter @workspace/api-server run build

# ── Stage 2: Production runner ────────────────────────────────────────────────
FROM node:20-slim AS runner

WORKDIR /workspace

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@9

# Copy workspace manifest files (needed to resolve workspace packages on install)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml \
     tsconfig.base.json tsconfig.json ./

# Copy shared lib packages (needed for pnpm workspace resolution)
COPY lib/api-zod    ./lib/api-zod
COPY lib/db         ./lib/db
COPY lib/api-spec   ./lib/api-spec

# Copy api-server package.json only (no source)
COPY artifacts/api-server/package.json ./artifacts/api-server/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built output from builder stage
COPY --from=builder /workspace/artifacts/api-server/dist ./artifacts/api-server/dist

# Set up working directory and data volume
WORKDIR /workspace/artifacts/api-server
RUN mkdir -p data logs

# ── Environment ───────────────────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/workspace/artifacts/api-server/data

EXPOSE 3000

# Persistent data (SQLite DB + logs)
VOLUME ["/workspace/artifacts/api-server/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
