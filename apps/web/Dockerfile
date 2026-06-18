# Multi-stage Dockerfile for the midplane-cloud control plane (apps/web).
#
# Built and deployed by Fly via fly-web.toml at the repo root. This image
# is the public dashboard + Next.js API + /mcp/<token> proxy. It runs on
# Fly so it shares the same 6PN private network as the regional runtime
# apps (midplane-eu, midplane-us) — FlyMachineSpawner returns IPv6
# private IPs, and only same-org Fly apps can reach them.
#
# Build context is the repo root.

# ---- deps: install with frozen lockfile ----------------------------------
FROM oven/bun:1.3-slim AS deps
WORKDIR /app

# Workspace root + every per-package package.json so bun install sees the
# same graph as CI. bunfig.toml pins linker = "hoisted". The engine manifests
# are required too: post-merge there is ONE root bun.lock covering the whole
# monorepo, and `bun install --frozen-lockfile` errors if any workspace member
# named in the lockfile is missing. (The web image does not USE the engine —
# Next's standalone trace prunes it — but the install must still resolve it.)
COPY package.json bun.lock bunfig.toml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/kms/package.json packages/kms/package.json
COPY packages/router/package.json packages/router/package.json
COPY infra/telemetry-proxy/package.json infra/telemetry-proxy/package.json
COPY engine/packages/engine/package.json engine/packages/engine/package.json
COPY engine/packages/mcp-server/package.json engine/packages/mcp-server/package.json
COPY engine/examples/smoketest/package.json engine/examples/smoketest/package.json

RUN bun install --frozen-lockfile

# ---- builder: produce the Next.js standalone bundle ----------------------
FROM oven/bun:1.3-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# No NEXT_PUBLIC_* build args needed: the Better Auth client is same-origin (no
# publishable key baked into the bundle), and BETTER_AUTH_SECRET /
# MIDPLANE_REGION_COOKIE_SECRET are runtime Fly secrets, not build-time values.
RUN bun --filter '@midplane-cloud/web' build

# ---- runner: minimal image, no toolchain ---------------------------------
FROM oven/bun:1.3-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# `output: 'standalone'` + `outputFileTracingRoot: <repo root>` writes:
#   apps/web/.next/standalone/{apps/web,packages/*,node_modules,...}
# We copy that whole tree to /app and start the entry at apps/web/server.js.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static

EXPOSE 3000

CMD ["bun", "run", "apps/web/server.js"]
