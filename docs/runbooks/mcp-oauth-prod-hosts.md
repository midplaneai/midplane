# Runbook — MCP OAuth prod hosts (issuer vs. MCP endpoint)

Pre-launch verification of the P6 MCP OAuth flow against the prod Fly setup.
Confirms the two hosts an agent touches — the **MCP endpoint** and the **OAuth
issuer** — resolve consistently, so the discovery → authorize → token →
MCP-call handshake completes. Companion to
[`docs/designs/credentials-and-scope-model.md`](../designs/credentials-and-scope-model.md).

## The two hosts

An MCP agent (Claude Code, Cursor, Claude Desktop) touches two hosts during the
OAuth handshake. They are **different subdomains served by the same regional web
app** (`midplane-web` / `midplane-web-us`):

| | env var | eu | us | served by |
|---|---|---|---|---|
| **MCP endpoint** (where the agent connects) | `MIDPLANE_PUBLIC_HOST_<region>` | `eu.midplane.ai` | `us.midplane.ai` | the regional web app (`/mcp/<connectionId>`) |
| **OAuth issuer** (discovery + authorize/token/register) | `BETTER_AUTH_URL` | `https://eu.app.midplane.ai` | `https://us.app.midplane.ai` | the regional web app (`/api/auth/*`, `/.well-known/*`) |

Both hosts hit the **same** `midplane-web{,-us}` app and therefore the **same**
Better Auth instance + regional Postgres. That is why a bearer minted at the
issuer host validates when presented at the MCP-endpoint host — `oauth_access_token`
lives in the one regional DB, and `withMcpAuth` on `/mcp/<id>` reads it there.

> The customer-facing MCP URL on the connection page is built by
> `mcpConnectionUrl(region, connectionId, env)` =
> `https://<MIDPLANE_PUBLIC_HOST_<region>>/mcp/<connectionId>`
> (`packages/router/src/region.ts`). The issuer is `BETTER_AUTH_URL`, asserted
> at boot by `apps/web/src/lib/assert-boot-env.ts` and consumed as
> `betterAuth({ baseURL })` in `apps/web/src/lib/auth.ts`.

## The handshake (what must resolve)

1. Agent POSTs `https://eu.midplane.ai/mcp/<connId>` with no bearer →
   `withMcpAuth` returns **401 + `WWW-Authenticate`** pointing at
   `BETTER_AUTH_URL/.well-known/oauth-protected-resource`
   (= `https://eu.app.midplane.ai/.well-known/oauth-protected-resource`).
2. Agent fetches that protected-resource metadata → learns the authorization
   server (`https://eu.app.midplane.ai`).
3. Agent fetches `…/.well-known/oauth-authorization-server` → authorize / token /
   register endpoints (all under `/api/auth/mcp/*` on the issuer host).
4. DCR → authorize (browser sign-in, forced consent) → token, all at the issuer.
5. Agent presents the bearer back to `https://eu.midplane.ai/mcp/<connId>`;
   `withMcpAuth` validates it against the same regional DB → `proxyMcpOAuth`.

**Invariant:** `BETTER_AUTH_URL` MUST serve `/api/auth/*` + `/.well-known/oauth-*`
(it does — it's the web app's own origin), and `MIDPLANE_PUBLIC_HOST_<region>`
MUST be served by the **same** regional web app (so token validation hits the
same DB). Root mirrors of both `.well-known/*` routes exist
(`apps/web/src/app/.well-known/oauth-*`) for clients that probe the root instead
of following `WWW-Authenticate`.

## Expected prod values

`fly secrets set` on each app (NOT in `[env]` — secrets only):

```
# midplane-web (EU; also serves apex app.midplane.ai)
BETTER_AUTH_URL=https://eu.app.midplane.ai
MIDPLANE_PUBLIC_HOST_EU=eu.midplane.ai

# midplane-web-us (US)
BETTER_AUTH_URL=https://us.app.midplane.ai
MIDPLANE_PUBLIC_HOST_US=us.midplane.ai
```

`BETTER_AUTH_URL` is the app's **own regional** origin — never the apex
`app.midplane.ai` and never the other region. OAuth is region-resident: each app
issues and validates tokens only against its own DB.

## Gaps found (fix before launch)

1. **`BETTER_AUTH_URL` was undocumented in the fly-web secrets blocks.** It is
   required and boot-enforced (`assert-boot-env.ts`), but the `fly secrets`
   comment in `fly-web-eu.toml` / `fly-web-us.toml` didn't list it — a fresh
   deploy would fail-closed at boot with no doc pointer. **Fixed**: added to both
   secrets comment blocks.

2. **The regional MCP-endpoint host needs its own TLS cert + route on the web
   app.** The cert comment in `fly-web-eu.toml` listed only `eu.app.midplane.ai`
   + `app.midplane.ai`; `eu.midplane.ai` (the MCP endpoint) was missing. Fly
   matches certs by SNI, so without it the MCP endpoint fails TLS. **Fixed**:
   added the `fly certs add <region>.midplane.ai` line to both web configs.
   Verify in prod:

   ```
   fly certs list --app midplane-web      # must include eu.midplane.ai
   fly certs list --app midplane-web-us   # must include us.midplane.ai
   curl -sI https://eu.midplane.ai/api/health   # 200 (proves the host routes here)
   ```

3. **Protected-resource `resource` advertised the issuer host, not the MCP host.
   FIXED.** The `mcp()` plugin's `resource` option was unset, so the RFC 9728
   metadata named the issuer origin (`<region>.app.midplane.ai`) rather than the
   MCP-endpoint origin (`<region>.midplane.ai`). Lenient clients (older TS SDK)
   used the metadata only to discover the auth server and worked, but a strict
   client that validates resource-binding rejected the connection — **Claude Code
   surfaced exactly this**: `SDK auth failed: Protected resource
   https://us.app.midplane.ai does not match expected https://us.midplane.ai/mcp
   (or origin)`. **Fixed**: set `mcp({ resource: mcpOrigin(region, process.env), … })`
   in `apps/web/src/lib/auth.ts`, reusing the `mcpOrigin` single source of truth
   (`packages/router/src/region.ts`) so cloud (per-region host), self-host
   (BETTER_AUTH_URL), and dev (localhost) all resolve correctly. The **origin**
   (no `/mcp` path) is advertised deliberately — it's the one value that matches
   both the region-wide `/mcp` and the per-project `/mcp/<projectId>` endpoints
   (strict clients accept the resource OR its origin). `mcpOrigin` reads
   `options.resource` in BOTH protected-resource routes (the plugin's own
   `/api/auth/.well-known/oauth-protected-resource` and the root-mirror
   `oAuthProtectedResourceMetadata`), so both now agree. `authorization_servers`
   still names the issuer origin — correct, the auth server lives on the issuer
   host. Regression guards: `mcpOrigin` unit tests in
   `packages/router/test/region.test.ts` + a protected-resource assertion in
   `e2e/mcp-oauth.live.e2e.ts`.

## Smoke checks (post-deploy, both regions)

```
# 1. Discovery resolves on the issuer host:
curl -s https://eu.app.midplane.ai/.well-known/oauth-authorization-server | jq '.issuer, .authorization_endpoint, .token_endpoint, .registration_endpoint'
#    issuer must equal https://eu.app.midplane.ai

# 2. The 401 challenge from the MCP host points at the issuer:
curl -sD - -o /dev/null -X POST https://eu.midplane.ai/mcp/<anyConnId> \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
#    → 401 with: WWW-Authenticate: Bearer resource_metadata="https://eu.app.midplane.ai/.well-known/oauth-protected-resource"

# 3. Protected-resource `resource` names the MCP-endpoint host, NOT the issuer
#    (the Gap #3 fix — a strict client like Claude Code rejects a mismatch):
curl -s https://eu.app.midplane.ai/.well-known/oauth-protected-resource | jq '.resource, .authorization_servers'
#    resource            must equal https://eu.midplane.ai   (the MCP-endpoint origin)
#    authorization_servers must equal ["https://eu.app.midplane.ai"] (the issuer)
#    The root mirror on the MCP host must return the SAME body:
curl -s https://eu.midplane.ai/.well-known/oauth-protected-resource | jq '.resource'
#    → "https://eu.midplane.ai"

# 4. End-to-end agent flow: covered by e2e/mcp-oauth.live.e2e.ts (E2E_LIVE=1).
```
