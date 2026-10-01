// A stand-in for a vendor tunnel's proxy (Anthropic's mcp-proxy, OpenAI's
// tunnel-client): it forwards each request by its Host to one upstream, and
// refuses hosts it has no route for. A route may rewrite Host to the
// upstream's name, as some proxies do. It streams both ways, so Server-Sent
// Events pass through as they would.
//
// Tunnel hostnames end in `.localhost`, and `localFetch` stands in for DNS:
// it reaches such a name on 127.0.0.1 while sending its real Host.

import {
  createServer,
  type IncomingHttpHeaders,
  request,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export interface TunnelRoute {
  /** Where requests for this host name go, e.g. `http://127.0.0.1:7433`. */
  upstream: string;
  /** The Host sent upstream instead of the tunnel's, e.g. `midplane-gateway`. */
  rewriteHost?: string;
}

export interface Tunnel {
  port: number;
  /** `http://<name>:<port>`, the public URL of a route. */
  url(name: string): string;
  /** Add or replace the route for a host name. */
  route(name: string, route: TunnelRoute): void;
  /** Requests forwarded, by the Host sent upstream. */
  forwarded: string[];
  close(): Promise<void>;
}

export async function startTunnel(): Promise<Tunnel> {
  const routes = new Map<string, TunnelRoute>();
  const forwarded: string[] = [];
  const server: Server = createServer((req, res) => {
    const name = new URL(`http://${req.headers.host ?? ""}`).hostname;
    const route = routes.get(name);
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`no route for ${name}`);
      return;
    }
    const upstream = new URL(route.upstream);
    const host = route.rewriteHost ?? (req.headers.host as string);
    forwarded.push(host);
    const out = request(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    out.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(out);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: (name) => `http://${name}:${port}`,
    route: (name, route) => {
      routes.set(name, route);
    },
    forwarded,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else if (v !== undefined) headers.set(k, v);
  }
  return headers;
}

/**
 * `fetch`, except that a `*.localhost` name is reached on 127.0.0.1 with
 * its own Host header, as DNS would route a tunnel's hostname to it.
 */
export const localFetch: typeof fetch = async (input, init) => {
  const req = new Request(input, init);
  const url = new URL(req.url);
  if (!url.hostname.endsWith(".localhost")) return fetch(req);
  const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
  const headers: Record<string, string> = Object.fromEntries(req.headers);
  headers.host = url.host;
  if (body) headers["content-length"] = String(body.length);
  return new Promise<Response>((resolve, reject) => {
    const out = request(
      {
        host: "127.0.0.1",
        port: url.port || 80,
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers,
        signal: req.signal,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 304 || req.method === "HEAD";
        if (empty) res.resume();
        resolve(
          new Response(
            empty ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
            { status, headers: toHeaders(res.headers) },
          ),
        );
      },
    );
    out.on("error", reject);
    out.end(body ?? undefined);
  });
};
