// Streamable HTTP proxy core.
//
// Forwards a Next.js Request to a spawned OSS container running on
// http://<host>:<port>/mcp. Preserves headers (especially mcp-session-id
// and accept), method, body, and streams the response back so SSE-style
// notifications work without buffering.
//
// fly-replay note: the OSS transport sets `fly-replay: cache_key=<session>`
// on its responses for Fly's anycast session affinity. We proxy DIRECTLY to
// the per-token machine (registry → 6PN IP), so we don't need it — and we
// must STRIP it on the way out. Leaking it past the public Fly edge in front
// of THIS web app makes fly-proxy try to replay the client's request, loop,
// and bail with [PA02] "'fly-replay' response header was returned too many
// times" → 502. Session affinity is preserved by the registry, not the
// header. See STRIP_RESPONSE_HEADERS below.
//
// Multi-DB rollout (0008): one OSS container fronts N DBs. The proxy
// resolves the parent connection + its children, decrypts each DSN
// independently (one DecryptCache entry per credential), then hands the
// full set to the spawner — which writes the multi-DB YAML and injects
// per-DB env vars.
//
// PR2 of mcp_url_auth_security (hybrid model):
//   - resolveByToken returns a token id alongside connection+databases.
//   - The proxy injects `X-Midplane-Token-Id: <tokenId>` on the forwarded
//     request; OSS 0.6.0 session-freezes the value on MCP initialize and
//     stamps it on every emitted audit row.
//   - Last-used surface (last_used_at/_ip/_ua) is bumped fire-and-forget
//     with a 5-min debounce — the request must not block on this write
//     and must not fail because of it.

import {
  bumpLastUsed,
  resolveByToken,
  resolveConnectionForCustomer,
} from "@midplane-cloud/router";
import {
  customers,
  getDb,
  parseGuardrailsOrThrow,
  parsePolicyOrThrow,
  parseTenantScopeOrThrow,
  type Connection,
  type ConnectionDatabase,
  type Region,
} from "@midplane-cloud/db";
import { member } from "@midplane-cloud/db/auth-schema";
import { loadPepperFromKms } from "@midplane-cloud/kms/pepper";
import { and, eq } from "drizzle-orm";

import { getMcpProxyContext } from "./mcp-proxy.ts";
import { bootRegion } from "./region-context.ts";
import { isSelfHost, SELF_HOST_CUSTOMER_ID } from "./self-host.ts";
import { ensureOAuthAttributionToken } from "./tokens.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

// Engine response headers that must NOT reach the public Fly edge. fly-replay
// (+ fly-replay-src) are the engine app's internal anycast routing signals;
// the edge fronting this web app would act on them, loop, and return [PA02].
// We already hit the right machine directly, so they carry no value here.
const STRIP_RESPONSE_HEADERS = new Set(["fly-replay", "fly-replay-src"]);

// Build the client-facing headers from the engine's response: drop hop-by-hop
// headers and the Fly routing-control headers (see above), keep everything else
// (notably mcp-session-id and content-type for SSE). Exported so the stripping
// has a regression test without standing up the full proxy.
export function filterUpstreamResponseHeaders(src: Headers): Headers {
  const out = new Headers();
  for (const [k, v] of src) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower) || STRIP_RESPONSE_HEADERS.has(lower)) continue;
    out.set(k, v);
  }
  return out;
}

// Pepper map is loaded once per process and reused across requests. The
// kid → buffer table is required by resolveByToken (HMAC-SHA256 lookup
// per kid). We deliberately fetch lazily on first request rather than at
// module init so a test or dev process without the env var set can still
// import this module; the first request will surface the misconfig with
// the env-loader's own fail-fast message.
let pepperPromise: Promise<Map<string, Buffer>> | null = null;
function getPeppers(): Promise<Map<string, Buffer>> {
  if (!pepperPromise) {
    pepperPromise = loadPepperFromKms(bootRegion(), process.env);
  }
  return pepperPromise;
}

/** Truncate a client-supplied IP/UA before it lands on the row. The
 *  proxy is the trust boundary — a hostile agent can stuff arbitrary
 *  values here, so defensively cap each. The UA cap matches the
 *  router-side cap in bumpLastUsed; the IP cap matches the inet text
 *  representation upper bound (IPv6 with zone id). */
const MAX_IP_LEN = 64;

function extractIp(req: Request): string | null {
  // Prefer x-forwarded-for (Fly edge populates this with the customer
  // client IP) and fall back to x-real-ip. Both can contain a comma-
  // separated chain; take the leftmost (= original client) and trim.
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first.slice(0, MAX_IP_LEN);
  }
  const xri = req.headers.get("x-real-ip");
  if (xri) return xri.slice(0, MAX_IP_LEN);
  return null;
}

export async function proxyMcp(
  req: Request,
  token: string,
): Promise<Response> {
  // proxyMcp IS the production MCP ingress. Customer /mcp/<token> traffic
  // hits the web app here (eu/us.midplane.ai → midplane-web{,-us}); we
  // resolve the token, decrypt the DSN, spawn/reuse the OSS container, and
  // proxy to it over private 6PN. The engine apps (midplane-eu/us) only host
  // those private containers — they take no public MCP traffic. bootRegion()
  // pins this app's single region so the lookup hits the right (only) DB.
  const region = bootRegion();
  let peppers: Map<string, Buffer>;
  try {
    peppers = await getPeppers();
  } catch (err) {
    // Pepper misconfig is a deploy-time error, not a per-request one;
    // surface as a 500 with no token-existence information.
    console.error("[proxyMcp] pepper load failed", err);
    return Response.json(
      { ok: false, error: "service_misconfigured" },
      { status: 500 },
    );
  }

  const db = getDb(region);
  const resolved = await resolveByToken(db, token, region, peppers);
  if (!resolved.ok) {
    // Paused → distinct 403 so the agent (and our logs) can tell "owner
    // hit the kill switch" apart from a bad/unknown token (404). The token
    // and its URL are intact; resuming the connection restores service.
    if (resolved.reason === "paused") {
      return Response.json(
        { ok: false, error: "connection_paused" },
        { status: 403 },
      );
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  // Fire-and-forget last-used bump (HMAC path). The 5-min debounce predicate
  // lives in SQL so concurrent in-window requests collapse at the row level.
  // Errors are logged but never block / fail the forwarded request.
  const ip = extractIp(req);
  const ua = req.headers.get("user-agent");
  void bumpLastUsed(db, resolved.tokenId, ip, ua).catch((err) => {
    console.error("[proxyMcp] bumpLastUsed failed", err);
  });

  return forwardResolved(req, {
    connection: resolved.connection,
    databases: resolved.databases,
    tokenId: resolved.tokenId,
  });
}

// Minimal structural view of the OAuth access-token record withMcpAuth passes
// to the handler (better-auth's oauthAccessToken row). We read only the three
// fields the proxy needs; userId can be null on the record's type so we guard.
export interface OAuthMcpSession {
  userId?: string | null;
  clientId?: string | null;
  scopes?: string | null;
}

/** MCP-OAuth ingress: the agent presented an OAuth 2.1 bearer (already validated
 *  by withMcpAuth) and reached `/mcp/<connectionId>`. The bearer authenticates
 *  the user + OAuth client; the path selects the connection. We:
 *    1. require the `mcp` scope on the token (else 403 insufficient_scope),
 *    2. map the OAuth user → their Midplane customer (the tenant),
 *    3. resolve the connection ONLY if that customer owns it (else 404),
 *    4. mint-or-get the (connection, client) attribution token so the engine
 *       still stamps a per-agent mcp_token_id on every audit row,
 *    5. forward to the engine through the SAME spawn/forward core as the URL
 *       path — same decrypt, same policy validation, same response filtering.
 *
 *  Coarse v1 scope model: an `mcp`-scoped bearer for a user who owns the
 *  connection grants full MCP access to it; per-connection policy/guardrails
 *  still apply in the engine exactly as for URL tokens. */
export async function proxyMcpOAuth(
  req: Request,
  connectionId: string,
  session: OAuthMcpSession,
): Promise<Response> {
  const region = bootRegion();
  const db = getDb(region);

  const userId = session.userId ?? null;
  const clientId = session.clientId ?? null;
  if (!userId || !clientId) {
    // A well-formed access token always carries both; absence means a
    // malformed/forged record slipped through. Refuse without confirming the
    // connection exists.
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // Scope gate. The bearer is valid (withMcpAuth), but validity alone is NOT
  // authorization to reach a database — a token minted for some other purpose
  // (a future OAuth-protected resource, or a client that requested only
  // openid/profile) must not grant MCP access. Require the `mcp` capability
  // scope before touching any connection. Our authorize before-hook forces this
  // scope onto every flow we issue (lib/auth.ts), so compliant clients always
  // carry it; this check is the defense-in-depth that rejects tokens that don't.
  const scopes = new Set((session.scopes ?? "").split(" ").filter(Boolean));
  if (!scopes.has("mcp")) {
    return Response.json(
      { ok: false, error: "insufficient_scope" },
      {
        status: 403,
        headers: {
          "WWW-Authenticate": 'Bearer error="insufficient_scope", scope="mcp"',
        },
      },
    );
  }

  const customerId = await resolveCustomerIdForUser(db, userId, region);
  if (!customerId) {
    // Authenticated user with no Midplane customer (e.g. signed up but never
    // picked a region). Nothing they can own — 403, not a connection-probing
    // 404/401.
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  const resolved = await resolveConnectionForCustomer(db, connectionId, customerId);
  if (!resolved.ok) {
    if (resolved.reason === "paused") {
      return Response.json(
        { ok: false, error: "connection_paused" },
        { status: 403 },
      );
    }
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Per-agent attribution: one mcp_tokens row per (connection, OAuth client).
  // Its id is what the engine stamps as mcp_token_id — so the OAuth flow keeps
  // the SAME audit attribution shape the URL token had.
  const tokenId = await ensureOAuthAttributionToken(db, {
    connectionId: resolved.connection.id,
    clientId,
    userId,
  });

  // Last-used surface, same debounce as the URL path (forensics + dashboard
  // parity for the attribution row).
  const ip = extractIp(req);
  const ua = req.headers.get("user-agent");
  void bumpLastUsed(db, tokenId, ip, ua).catch((err) => {
    console.error("[proxyMcpOAuth] bumpLastUsed failed", err);
  });

  return forwardResolved(req, {
    connection: resolved.connection,
    databases: resolved.databases,
    tokenId,
  });
}

/** Map an OAuth-authenticated user to the Midplane customer (tenant) they act
 *  as. Self-host: any authed user resolves to the single implicit customer
 *  (mirrors currentCustomer()). Cloud: the user's org → its customer, pinned to
 *  this regional DB. Returns null when the user has no customer yet. */
async function resolveCustomerIdForUser(
  db: ReturnType<typeof getDb>,
  userId: string,
  region: Region,
): Promise<string | null> {
  if (isSelfHost()) return SELF_HOST_CUSTOMER_ID;
  const rows = await db
    .select({ id: customers.id })
    .from(customers)
    .innerJoin(member, eq(member.organizationId, customers.orgId))
    .where(and(eq(member.userId, userId), eq(customers.region, region)))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** The shared engine spawn + forward core, reached by BOTH the URL-token path
 *  (proxyMcp) and the OAuth path (proxyMcpOAuth) once a connection + databases
 *  + attribution token id are resolved. Decrypts each DSN, validates policy at
 *  the boundary, spawns/reuses the container, forwards the Streamable HTTP
 *  request, and streams the filtered response back. The ONLY auth-method-
 *  specific input is the tokenId stamped on X-Midplane-Token-Id. */
async function forwardResolved(
  req: Request,
  resolved: {
    connection: Connection;
    databases: ConnectionDatabase[];
    tokenId: string;
  },
): Promise<Response> {
  const { connection, databases, tokenId } = resolved;
  if (databases.length === 0) {
    // Connection without children is a torn migration / data corruption —
    // can't spawn a container with no DSN. Treat as not_found to avoid
    // leaking the row's existence; the underlying issue surfaces in logs.
    // Log with tokenId only, never the plaintext token.
    console.error(
      `forwardResolved: connection ${connection.id} has no databases (tokenId=${tokenId})`,
    );
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const ctx = getMcpProxyContext();

  // Decrypt each child's DSN independently. Per-credential cache means
  // KMS unavailability for one DB doesn't block siblings; one expired
  // credential refuses the whole spawn (the OSS container needs every
  // configured DB to boot cleanly).
  const spawnDatabases = [];
  for (const cdb of databases) {
    const decrypt = await ctx.resolver.resolve({
      connectionDatabase: cdb,
      region: connection.region,
      customerId: connection.customerId,
    });
    if (!decrypt.ok) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32001, message: "credential_unavailable" },
          id: null,
        },
        { status: 503 },
      );
    }
    let tableAccess;
    let tenantScope;
    let guardrails;
    try {
      // Validate at the boundary — Postgres should never hold malformed
      // policy (validatePolicy gates every write), but if it somehow does,
      // fail closed instead of starting a container with a degraded YAML.
      // parseTenantScopeOrThrow normalizes legacy 0.4.x flat-map rows that
      // slipped past the 0012 backfill, so a pre-migration row reads as
      // { column: null, overrides: <old map>, exempt: [] }.
      // parseGuardrailsOrThrow resolves a null row (pre-0021) to the
      // default-ON posture, matching the engine's omitted-section default.
      tableAccess = parsePolicyOrThrow(cdb.tableAccess);
      tenantScope = parseTenantScopeOrThrow(cdb.tenantScope);
      guardrails = parseGuardrailsOrThrow(cdb.guardrails);
    } catch (err) {
      console.error("invalid policy at spawn", err);
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32002, message: "upstream_unavailable" },
          id: null,
        },
        { status: 502 },
      );
    }
    spawnDatabases.push({
      name: cdb.name,
      connectionDatabaseId: cdb.id,
      dsn: decrypt.plaintext,
      tableAccess,
      tenantScope,
      guardrails,
    });
  }

  let upstream;
  try {
    upstream = await ctx.registry.acquire({
      connectionId: connection.id,
      region: connection.region,
      databases: spawnDatabases,
    });
  } catch (err) {
    console.error("spawn failed", err);
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32002, message: "upstream_unavailable" },
        id: null,
      },
      { status: 502 },
    );
  }

  const upstreamUrl = `http://${upstream.host}:${upstream.port}/mcp`;
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);
  }
  // Per-token attribution header. OSS 0.6.0 reads this on MCP initialize,
  // session-freezes the value, and stamps it on every audit row from
  // the session. Safe to send on every request: post-initialize the
  // engine ignores re-sends. NEVER log the plaintext token; only tokenId
  // appears here. For the OAuth path this is the (connection, client)
  // attribution row id, so per-agent audit attribution is identical.
  headers.set("X-Midplane-Token-Id", tokenId);

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }

  let res: Response;
  try {
    res = await fetch(upstreamUrl, init);
  } catch (err) {
    // Container may have been killed externally. Drop registry entry so the
    // next request respawns.
    await ctx.registry.invalidate(connection.id).catch(() => undefined);
    console.error("proxy fetch failed", err);
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32003, message: "upstream_disconnected" },
        id: null,
      },
      { status: 502 },
    );
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: filterUpstreamResponseHeaders(res.headers),
  });
}
