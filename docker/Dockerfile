# Production Dockerfile for `midplaneai/midplane`. Built from the workspace root.
#
#   docker build -f docker/Dockerfile -t midplaneai/midplane:dev .

# ── Stage 1: deps ─────────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

# Manifests + lockfile only, for cache-friendly installs.
# Every workspace package.json is required so `bun install --frozen-lockfile`
# can resolve the workspace graph (root + engine + mcp-server + smoketest).
COPY package.json bun.lock ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/mcp-server/package.json ./packages/mcp-server/
COPY examples/smoketest/package.json ./examples/smoketest/

RUN bun install --frozen-lockfile --production

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine
WORKDIR /app

# curl: container HEALTHCHECK. sqlite: ad-hoc audit-log inspection from inside.
RUN apk add --no-cache curl sqlite

# Non-root runtime identity. uid/gid 1001 to avoid colliding with common host users.
RUN addgroup -S -g 1001 midplane && adduser -S -u 1001 -G midplane midplane

# Bun's workspace install uses an isolated layout: deps land under each
# package's local node_modules, with symlinks pointing at workspace siblings.
# Preserve all three so `@midplane/engine` resolves from mcp-server at runtime.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/engine/node_modules ./packages/engine/node_modules
COPY --from=deps /app/packages/mcp-server/node_modules ./packages/mcp-server/node_modules

COPY package.json bun.lock ./
COPY packages ./packages

RUN mkdir -p /data && chown -R midplane:midplane /app /data

USER midplane

ENV PORT=8080
ENV DB_PATH=/data/audit.db
ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -sf "http://localhost:${PORT}/health" || exit 1

CMD ["bun", "run", "packages/mcp-server/src/index.ts"]
