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
import { randomUUID } from "node:crypto";
import { logger } from "../logger.ts";

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

export async function startHttp(
  serverFactory: ServerFactory,
  opts: { port: number; host?: string },
): Promise<HttpHandle> {
  const sessions = new Map<string, SessionEntry>();

  const httpServer = createServer((req, res) =>
    handle(req, res, serverFactory, sessions).catch((err) => {
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
): Promise<void> {
  const url = req.url ?? "/";

  if (req.method === "GET" && url === "/health") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
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
