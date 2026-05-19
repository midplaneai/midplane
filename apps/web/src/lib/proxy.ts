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
// per-DB env vars. PR-A leaves the user surface single-DB; the cloud
// always emits the multi-DB shape regardless of N.

import { resolveByToken } from "@midplane-cloud/router";
import {
  getDb,
  parsePolicyOrThrow,
  parseTenantScopeOrThrow,
} from "@midplane-cloud/db";

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

export async function proxyMcp(
  req: Request,
  token: string,
): Promise<Response> {
  // proxyMcp on the control-plane web app is only hit in local dev / E2E —
  // production /mcp/<token> traffic goes to the regional data-plane apps
  // (eu.midplane.ai / us.midplane.ai). Use the boot region so the local
  // dev path resolves against the single configured DB.
  const resolved = await resolveByToken(getDb(bootRegion()), token);
  if (!resolved) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const { connection, databases } = resolved;
  if (databases.length === 0) {
    // Connection without children is a torn migration / data corruption —
    // can't spawn a container with no DSN. Treat as not_found to avoid
    // leaking the row's existence; the underlying issue surfaces in logs.
    console.error(
      `proxyMcp: connection ${connection.id} has no databases (token ${token.slice(0, 8)}…)`,
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
      token: connection.mcpToken,
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
    await ctx.registry.invalidate(connection.mcpToken).catch(() => undefined);
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
