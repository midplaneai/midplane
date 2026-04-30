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

import { resolveByToken } from "@midplane-cloud/router";
import { getDb, parsePolicyOrThrow } from "@midplane-cloud/db";

import { getMcpProxyContext } from "./mcp-proxy.ts";

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
  const conn = await resolveByToken(getDb(), token);
  if (!conn) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const ctx = getMcpProxyContext();
  const decrypt = await ctx.resolver.resolve(conn);
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

  let upstream;
  try {
    // Validate at the boundary — Postgres should never hold malformed
    // policy (validatePolicy gates every write), but if it somehow does,
    // fail closed instead of starting a container with a degraded YAML.
    const tableAccess = parsePolicyOrThrow(conn.tableAccess);
    upstream = await ctx.registry.acquire({
      token: conn.mcpToken,
      region: conn.region,
      dsn: decrypt.plaintext,
      tableAccess,
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
    await ctx.registry.invalidate(conn.mcpToken).catch(() => undefined);
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
