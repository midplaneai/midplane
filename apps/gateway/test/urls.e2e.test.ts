// One gateway on several URLs at once: directly on its listener, and behind
// a stand-in tunnel that forwards by hostname. A token for either URL works
// on both, a token for another gateway works on neither, a request for a
// host it isn't registered for is refused, and the metadata names the URL a
// client came in on. Local mode; the cloud's side is in the cloud's suites.

import { createServer } from "node:net";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  hasPostgres,
  startGateway,
  type TestDatabase,
  type TestGateway,
} from "./harness.ts";
import { localFetch, startTunnel, type Tunnel } from "./tunnel.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

const TUNNEL_HOST = "db.abc123.tunnel.localhost";

/** One MCP request on the 2025 handshake, through `fetch`. */
async function rpc(
  url: string,
  token: string | null,
  method: string,
  params: unknown = {},
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await localFetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  let body: unknown = text;
  try {
    body = JSON.parse(data ? data.slice(6) : text);
  } catch {
    // leave as text
  }
  return { status: res.status, body, headers: res.headers };
}

async function rows(url: string, token: string): Promise<unknown> {
  const r = await rpc(url, token, "tools/call", {
    name: "query",
    arguments: { sql: "SELECT name FROM users ORDER BY id" },
  });
  if (r.status !== 200) return r.status;
  return (r.body as { result?: { structuredContent?: { rows: unknown } } })
    .result?.structuredContent?.rows;
}

describe.skipIf(!hasPostgres)("a gateway on several URLs", () => {
  let db: TestDatabase;
  let tunnel: Tunnel;
  let gw: TestGateway;
  let direct: string;
  let viaTunnel: string;

  beforeAll(async () => {
    db = await createDatabase(
      `CREATE TABLE users (id int PRIMARY KEY, name text);
       INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob');`,
      (role) => `GRANT SELECT ON users TO ${role};`,
    );
    tunnel = await startTunnel();
    const port = await freePort();
    direct = `http://127.0.0.1:${port}`;
    viaTunnel = tunnel.url(TUNNEL_HOST);
    // The tunnel's URL first: a tunnel that rewrites Host hides which URL
    // a client used, and the gateway then names its first.
    gw = await startGateway(
      {
        main: {
          dsn: db.agentDsn,
          policy: { table_access: { tables: { "public.users": "read" } } },
        },
      },
      {
        port,
        publicUrls: [viaTunnel, direct],
        allowedHosts: ["midplane-gateway"],
      },
    );
    tunnel.route(TUNNEL_HOST, { upstream: direct });
    // A hostname routed to the gateway that isn't one of its URLs.
    tunnel.route("stray.tunnel.localhost", { upstream: direct });
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    await tunnel?.close();
    await db?.drop();
  });

  it("names the URL a client came in on in its metadata", async () => {
    for (const base of [direct, viaTunnel]) {
      const prm = (await (
        await localFetch(`${base}/.well-known/oauth-protected-resource/mcp`)
      ).json()) as Record<string, unknown>;
      expect(prm.resource, base).toBe(`${base}/mcp`);
      const challenge = await rpc(`${base}/mcp`, null, "initialize");
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toContain(
        `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      );
    }
    expect(tunnel.forwarded).toContain(`${TUNNEL_HOST}:${tunnel.port}`);
  });

  it("takes a token for either URL on both", async () => {
    const forDirect = await gw.token({ audience: `${direct}/mcp` });
    const forTunnel = await gw.token({ audience: `${viaTunnel}/mcp` });
    for (const token of [forDirect, forTunnel]) {
      for (const base of [direct, viaTunnel]) {
        expect(await rows(`${base}/mcp`, token)).toEqual([["Alice"], ["Bob"]]);
      }
    }
  });

  it("refuses a token for another gateway on both", async () => {
    const other = await gw.token({ audience: "https://other.example.com/mcp" });
    for (const base of [direct, viaTunnel]) {
      expect(await rows(`${base}/mcp`, other)).toBe(401);
    }
  });

  it("refuses a request for a host it isn't registered for", async () => {
    const token = await gw.token();
    // Through the tunnel, and straight at its port under another name, as
    // a DNS rebinding page would reach it.
    for (const url of [
      `${tunnel.url("stray.tunnel.localhost")}/mcp`,
      `http://rebound.localhost:${new URL(direct).port}/mcp`,
    ]) {
      const r = await rpc(url, token, "tools/list");
      expect(r.status, url).toBe(403);
      expect(JSON.stringify(r.body)).toMatch(/Invalid Host/);
    }
  });

  it("answers behind a tunnel that rewrites Host, naming its first URL", async () => {
    const port = new URL(direct).port;
    // To a name in listen.allowed_hosts, or to the loopback address it is
    // reached at, as OpenAI's tunnel-client does.
    for (const rewriteHost of [
      `midplane-gateway:${port}`,
      `localhost:${port}`,
    ]) {
      tunnel.route(TUNNEL_HOST, { upstream: direct, rewriteHost });
      try {
        const prm = (await (
          await localFetch(`${viaTunnel}/.well-known/oauth-protected-resource`)
        ).json()) as Record<string, unknown>;
        expect(prm.resource, rewriteHost).toBe(`${viaTunnel}/mcp`);
        const token = await gw.token({ audience: `${viaTunnel}/mcp` });
        expect(await rows(`${viaTunnel}/mcp`, token), rewriteHost).toEqual([
          ["Alice"],
          ["Bob"],
        ]);
        expect(tunnel.forwarded.at(-1)).toBe(rewriteHost);
      } finally {
        tunnel.route(TUNNEL_HOST, { upstream: direct });
      }
    }
  });

  it("serves the 2026-07-28 handshake through the tunnel", async () => {
    const token = await gw.token({ audience: `${direct}/mcp` });
    const client = new Client(
      { name: "e2e", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    const transport = new StreamableHTTPClientTransport(
      new URL(`${viaTunnel}/mcp`),
      {
        fetch: localFetch,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      },
    );
    await client.connect(transport);
    try {
      expect(transport.protocolVersion).toBe("2026-07-28");
      const r = (await client.callTool({
        name: "query",
        arguments: { sql: "SELECT count(*) AS n FROM users" },
      })) as { structuredContent?: { rows: unknown[][] } };
      expect(r.structuredContent?.rows).toEqual([["2"]]);
    } finally {
      await client.close();
    }
  });
});
