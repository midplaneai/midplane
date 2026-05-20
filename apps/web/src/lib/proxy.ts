// Streamable HTTP proxy core.
//
// Forwards a Next.js Request to a spawned OSS container running on
// http://<host>:<port>/mcp. Preserves headers (especially mcp-session-id
// and accept), method, body, and streams the response back so SSE-style
// notifications work without buffering.
//
// fly-replay note: the OSS transport sets `fly-replay: cache_key=<session>`
// on its responses. We pass that header through unchanged. Off-Fly the
// header is inert; on Fly the edge uses it to pin subsequent requests in
// the same session to the same machine.
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

import { bumpLastUsed, resolveByToken } from "@midplane-cloud/router";
import {
  getDb,
  parsePolicyOrThrow,
  parseTenantScopeOrThrow,
} from "@midplane-cloud/db";
import { loadPepperFromKms } from "@midplane-cloud/kms/pepper";

import { getMcpProxyContext } from "./mcp-proxy.ts";
import { bootRegion } from "./region-context.ts";

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
  // proxyMcp on the control-plane web app is only hit in local dev / E2E —
  // production /mcp/<token> traffic goes to the regional data-plane apps
  // (eu.midplane.com / us.midplane.com). Use the boot region so the local
  // dev path resolves against the single configured DB.
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
  if (!resolved) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const { connection, databases, tokenId } = resolved;
  if (databases.length === 0) {
    // Connection without children is a torn migration / data corruption —
    // can't spawn a container with no DSN. Treat as not_found to avoid
    // leaking the row's existence; the underlying issue surfaces in logs.
    // Log with tokenId only, never the plaintext token.
    console.error(
      `proxyMcp: connection ${connection.id} has no databases (tokenId=${tokenId})`,
    );
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  // Fire-and-forget last-used bump. The 5-min debounce predicate lives
  // in SQL so concurrent in-window requests collapse at the row level.
  // Errors are logged but never block / fail the forwarded request.
  const ip = extractIp(req);
  const ua = req.headers.get("user-agent");
  void bumpLastUsed(db, tokenId, ip, ua).catch((err) => {
    console.error("[proxyMcp] bumpLastUsed failed", err);
  });

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
    try {
      // Validate at the boundary — Postgres should never hold malformed
      // policy (validatePolicy gates every write), but if it somehow does,
      // fail closed instead of starting a container with a degraded YAML.
      // parseTenantScopeOrThrow normalizes legacy 0.4.x flat-map rows that
      // slipped past the 0012 backfill, so a pre-migration row reads as
      // { column: null, overrides: <old map>, exempt: [] }.
      tableAccess = parsePolicyOrThrow(cdb.tableAccess);
      tenantScope = parseTenantScopeOrThrow(cdb.tenantScope);
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
  // appears here.
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

  const outHeaders = new Headers();
  for (const [k, v] of res.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders.set(k, v);
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
  });
}
