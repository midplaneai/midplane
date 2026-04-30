// Streamable HTTP transport.
//
// Day-0 spike finding: MCP Streamable HTTP is node:http-shaped, NOT fetch-shaped.
// Use createServer((req, res) => transport.handleRequest(req, res)). Bun.serve
// fetch handler is incompatible with the SDK.
//
// Per-session transports: the SDK's StreamableHTTPServerTransport is
// session-stateful. Multiple concurrent MCP clients require one transport
// per session. We track them by mcp-session-id and route requests accordingly.
//
// fly-replay: hosted MCP requires session affinity per-token. On each response
// the transport sets `mcp-session-id`; we mirror that as
// `fly-replay: cache_key=<session-id>`. Off-Fly the header is inert.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { SqliteAuditWriter } from "@midplane/engine";
import { logger } from "../logger.ts";

const DEFAULT_AUDIT_LIMIT = 500;
const MAX_AUDIT_LIMIT = 1000;

export interface HttpHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

// The MCP SDK's McpServer holds a single Protocol → single transport. Each
// concurrent MCP session therefore needs its own McpServer instance. The
// caller provides a factory; it's invoked once per session.
export type ServerFactory = () => McpServer;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

export interface IndexerRoutes {
  audit: SqliteAuditWriter;
  // Bearer token from env. When undefined, the routes return 404 — audit
  // access is opt-in on self-host. The admin policy endpoint reuses this
  // same token (no second secret to plumb).
  token?: string;
}

export interface AdminRoutes {
  // Hot-swap the in-memory policy. Throws on YAML parse / schema errors;
  // the throw is mapped to a 400 response with the error message in the
  // body. Returns the wall-clock time the swap was applied.
  setPolicy: (yamlText: string) => Promise<{ applied_at: string }>;
}

export async function startHttp(
  serverFactory: ServerFactory,
  opts: {
    port: number;
    host?: string;
    indexer?: IndexerRoutes;
    admin?: AdminRoutes;
  },
): Promise<HttpHandle> {
  const sessions = new Map<string, SessionEntry>();

  const httpServer = createServer((req, res) =>
    handle(req, res, serverFactory, sessions, opts.indexer, opts.admin).catch((err) => {
      logger.error({ err }, "http handler threw");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("internal error");
      }
    }),
  );

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      httpServer.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      httpServer.removeListener("error", onError);
      resolve();
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListening);
    httpServer.listen(opts.port, opts.host ?? "0.0.0.0");
  });

  const addr = httpServer.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : opts.port;
  const url = `http://${opts.host ?? "0.0.0.0"}:${boundPort}/mcp`;
  logger.info({ port: boundPort, url }, "http transport listening");

  return {
    url,
    port: boundPort,
    async close() {
      // Snapshot — transport.close() triggers onclose which mutates the map.
      const entries = [...sessions.values()];
      for (const entry of entries) {
        await entry.transport.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  serverFactory: ServerFactory,
  sessions: Map<string, SessionEntry>,
  indexer: IndexerRoutes | undefined,
  admin: AdminRoutes | undefined,
): Promise<void> {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/health") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Audit indexer pull endpoints — opt-in via INDEXER_TOKEN. The unset-token
  // case 404s so a self-host server reveals nothing about the route's existence.
  if (req.method === "GET" && url.startsWith("/audit/since/")) {
    await handleAuditSince(req, res, url, indexer);
    return;
  }
  if (req.method === "DELETE" && url.startsWith("/audit/before/")) {
    await handleAuditBefore(req, res, url, indexer);
    return;
  }
  // Admin policy hot-swap — same INDEXER_TOKEN, same 404-when-unset posture
  // so self-hosts without the token reveal nothing.
  if (req.method === "POST" && url === "/admin/policy") {
    await handleAdminPolicy(req, res, indexer, admin);
    return;
  }

  if (!(url === "/mcp" || url.startsWith("/mcp?"))) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const sessionHeader = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

  // Body is needed both for routing decisions (initialize) and for the SDK.
  // Streamable HTTP only needs JSON parsing on POST.
  let parsedBody: unknown;
  if (req.method === "POST") {
    parsedBody = await readJson(req);
  }

  let entry = sessionId ? sessions.get(sessionId) : undefined;

  if (!entry) {
    if (req.method !== "POST" || !isInitializeRequest(parsedBody)) {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "missing or unknown mcp-session-id" },
          id: null,
        }),
      );
      return;
    }

    const server = serverFactory();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
        logger.info({ sessionId: id }, "session initialized");
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
        logger.info({ sessionId: transport.sessionId }, "session closed");
      }
      void server.close().catch(() => undefined);
    };
    await server.connect(transport);
    entry = { transport, server };
  }

  installFlyReplayMirror(res);
  await entry.transport.handleRequest(req, res, parsedBody);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Constant-time bearer check. Returns "missing" when the server has no
// expected token configured (route should 404 to avoid revealing it exists);
// "bad" for any auth failure; "ok" otherwise.
function checkBearer(
  req: IncomingMessage,
  expected: string | undefined,
): "ok" | "missing" | "bad" {
  if (!expected) return "missing";
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return "bad";
  const got = Buffer.from(h.slice("Bearer ".length));
  const want = Buffer.from(expected);
  if (got.length !== want.length) return "bad";
  return timingSafeEqual(got, want) ? "ok" : "bad";
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function handleAuditSince(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  indexer: IndexerRoutes | undefined,
): Promise<void> {
  const auth = checkBearer(req, indexer?.token);
  if (auth === "missing") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  if (auth === "bad") {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  // url is "/audit/since/<cursor>[?limit=N]"
  const parsed = new URL(url, "http://internal");
  const cursor = decodeURIComponent(parsed.pathname.slice("/audit/since/".length));
  const limit = clampLimit(parsed.searchParams.get("limit"));

  const rows = indexer!.audit.readSince(cursor, limit);
  const next_cursor = rows.length < limit ? null : rows[rows.length - 1]!.id;
  writeJson(res, 200, { rows, next_cursor });
}

async function handleAuditBefore(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  indexer: IndexerRoutes | undefined,
): Promise<void> {
  const auth = checkBearer(req, indexer?.token);
  if (auth === "missing") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  if (auth === "bad") {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  const parsed = new URL(url, "http://internal");
  const id = decodeURIComponent(parsed.pathname.slice("/audit/before/".length));
  const deleted = indexer!.audit.deleteThrough(id);
  writeJson(res, 200, { deleted });
}

async function handleAdminPolicy(
  req: IncomingMessage,
  res: ServerResponse,
  indexer: IndexerRoutes | undefined,
  admin: AdminRoutes | undefined,
): Promise<void> {
  const auth = checkBearer(req, indexer?.token);
  if (auth === "missing") {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  if (auth === "bad") {
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }
  // Token configured but no admin handle wired (e.g. shared http transport
  // bootstrapped without an engine yet). Surface as 503 so the cloud retries
  // rather than treating it as a config error.
  if (!admin) {
    writeJson(res, 503, { ok: false, error: "engine not ready" });
    return;
  }

  const text = await readText(req);
  let result: { applied_at: string };
  try {
    result = await admin.setPolicy(text);
  } catch (err) {
    // Parse / schema errors thrown by parsePolicyYaml are operator-facing —
    // pass the message through verbatim so the cloud UI can show it.
    writeJson(res, 400, { ok: false, error: (err as Error).message });
    return;
  }
  writeJson(res, 200, { ok: true, applied_at: result.applied_at });
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function clampLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_AUDIT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_AUDIT_LIMIT;
  return Math.min(n, MAX_AUDIT_LIMIT);
}

// Mirror mcp-session-id → fly-replay: cache_key=<id> on response.
// Inert when not running on Fly. Must be installed BEFORE handleRequest.
function installFlyReplayMirror(res: ServerResponse): void {
  const original = res.setHeader.bind(res);
  res.setHeader = function (
    name: string,
    value: number | string | readonly string[],
  ) {
    if (
      typeof name === "string" &&
      name.toLowerCase() === "mcp-session-id" &&
      typeof value === "string"
    ) {
      original("fly-replay", `cache_key=${value}`);
    }
    return original(name, value);
  } as typeof res.setHeader;
}
