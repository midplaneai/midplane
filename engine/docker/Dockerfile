# Production Dockerfile for `midplane/midplane`.
#
# Built from the REPO ROOT (the merged monorepo), because there is one root
# bun.lock for the whole workspace and `bun install --frozen-lockfile` needs
# every workspace member's package.json present to resolve the graph:
#
#   docker build -f engine/docker/Dockerfile -t midplane/midplane:dev .
#
# The engine ships as a single self-contained binary produced by
# `bun build --compile` — no node_modules in the runtime image. This keeps the
# query-path image tiny and minimal-attack-surface, and it is what dissolves the
# hoisted-vs-isolated linker tension of the monorepo merge (the runtime image
# carries no node_modules at all). See .context/p7-monorepo-merge-plan.md (T4).

# ── Stage 1: build — compile the self-contained binary ────────────────────────
FROM oven/bun:1.3-alpine AS build
WORKDIR /app

# Root manifests + lockfile + bunfig (linker=hoisted), then EVERY workspace
# member's package.json so `bun install --frozen-lockfile` resolves the merged
# graph. Manifest-only copy keeps this layer cache-friendly.
COPY package.json bun.lock bunfig.toml ./
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/kms/package.json ./packages/kms/
COPY packages/router/package.json ./packages/router/
COPY infra/telemetry-proxy/package.json ./infra/telemetry-proxy/
COPY engine/packages/engine/package.json ./engine/packages/engine/
COPY engine/packages/mcp-server/package.json ./engine/packages/mcp-server/
COPY engine/examples/smoketest/package.json ./engine/examples/smoketest/

RUN bun install --frozen-lockfile --production

# Engine source, then compile the CLI (mcp-server) to a single binary. The
# bundler embeds the libpg-query WASM and the audit schema.sql (static text
# import) so the binary is self-contained.
COPY engine/packages ./engine/packages
RUN bun build --compile ./engine/packages/mcp-server/src/cli.ts --outfile /app/midplane

# ── Stage 2: runtime — minimal base, just the binary ──────────────────────────
FROM alpine:3.20
WORKDIR /app

# curl: container HEALTHCHECK. sqlite: ad-hoc audit-log inspection from inside.
# libstdc++/libgcc: the bun-compiled binary links against them on musl.
RUN apk add --no-cache curl sqlite libstdc++ libgcc

# Non-root runtime identity. uid/gid 1001 to avoid colliding with common host users.
RUN addgroup -S -g 1001 midplane && adduser -S -u 1001 -G midplane midplane

# The compiled binary. `midplane` on PATH so `docker exec midplane
# midplane audit tail` works.
COPY --from=build /app/midplane /usr/local/bin/midplane

# libpg-query (the SQL parser) loads its WASM at runtime via
# `fs.readFileSync(__dirname + "/libpg-query.wasm")`. `bun build --compile` bakes
# __dirname to the build-time module path (/app/node_modules/libpg-query/wasm),
# and the Emscripten glue is auto-instantiated with no `locateFile` hook — so the
# .wasm can't be embedded in the binary. Ship that ONE asset at the baked path.
# (This is the only non-binary file the image needs; there is no node_modules tree.)
COPY --from=build /app/node_modules/libpg-query/wasm/libpg-query.wasm /app/node_modules/libpg-query/wasm/libpg-query.wasm

RUN mkdir -p /data && chown -R midplane:midplane /app /data

USER midplane

ENV PORT=8080
ENV DB_PATH=/data/audit.db
ENV NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -sf "http://localhost:${PORT}/health" || exit 1

CMD ["midplane", "server"]
