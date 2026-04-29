# Production Dockerfile for `midplaneai/midplane`. Built from the workspace root.
#
# Status: placeholder until @midplane/engine and @midplane/mcp-server have implementation code.
# The runtime stack (Bun 1.3 + libpg-query + bun:sqlite + @modelcontextprotocol/sdk) is
# validated by examples/smoketest/Dockerfile. This file will mirror that shape once the
# real packages are scaffolded.
#
# Build: docker build -f docker/Dockerfile -t midplaneai/midplane:dev .

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
RUN apk add --no-cache sqlite
COPY package.json bun.lock* ./
COPY packages/engine/package.json ./packages/engine/
COPY packages/mcp-server/package.json ./packages/mcp-server/
RUN bun install --production --frozen-lockfile || true
# `|| true` is temporary while package code is empty. Remove before V1 launch.

FROM oven/bun:1.3-alpine
WORKDIR /app
RUN apk add --no-cache sqlite
COPY --from=deps /app/node_modules ./node_modules
COPY packages ./packages
COPY package.json ./
RUN mkdir -p /data
EXPOSE 8080

# Defaults; override at runtime
ENV PORT=8080
ENV DB_PATH=/data/audit.db

CMD ["bun", "run", "packages/mcp-server/src/index.ts"]
