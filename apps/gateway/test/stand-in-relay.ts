// A stand-in for Midplane's relay (the cloud's relay.ts), as much of it as
// the gateway's side meets: the control name's TLS and its upgrade, idle
// work connections, and agents' connections, each piped over one after a
// PROXY line. Agents come in on two ports, one per destination port the
// line names: 443, TLS for the gateway; 80, plain HTTP for its challenge
// handler. Unlike the relay it reads no SNI and rewrites no request: what
// an agent sends on either port reaches the gateway as sent, so a test can
// try anything on either. The cloud's tests run the real relay.

import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import {
  type AddressInfo,
  createServer as createNetServer,
  type Server,
  type Socket,
} from "node:net";
import { Readable } from "node:stream";
import { createServer as createTlsServer, type TLSSocket } from "node:tls";
import {
  proxyLine,
  RELAY_CONNECT_PATH,
  RELAY_PING,
  RELAY_PORTS,
  RELAY_UPGRADE,
} from "@midplane/protocol";
import { testCertificate } from "./fake-acme.ts";

export interface StandInRelay {
  control: string;
  /** The control name's certificate, for the gateway to trust. */
  ca: string;
  /** Where gateways open work connections. */
  port: number;
  /** Agents' TLS: each connection a stream whose line names 443. */
  agentPort: number;
  /** Plain HTTP, the relay's port 80: each a stream whose line names 80. */
  httpPort: number;
  /** The token of each upgrade, in order. */
  tokens: string[];
  /** Answer the next upgrades with these statuses, in order, then 101. */
  refusals: number[];
  /** Every PROXY line written. */
  lines: string[];
  idle(): number;
  /** Ping every idle connection, as the relay does every 25 s. */
  ping(): void;
  close(): Promise<void>;
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );

/**
 * A relay for `control`. Each line names `source` as the agent, so a test
 * can tell the agent's address from the relay's.
 */
export async function startStandInRelay(o: {
  control: string;
  source: { address: string; port: number };
}): Promise<StandInRelay> {
  const own = testCertificate({ names: [o.control] });
  const idle = new Set<TLSSocket>();
  const open = new Set<Socket>();
  const track = (s: Socket) => {
    open.add(s);
    s.on("error", () => {});
    s.once("close", () => open.delete(s));
  };

  const relay: StandInRelay = {
    control: o.control,
    ca: own.cert,
    port: 0,
    agentPort: 0,
    httpPort: 0,
    tokens: [],
    refusals: [],
    lines: [],
    idle: () => idle.size,
    ping() {
      for (const s of idle) s.write(Buffer.of(RELAY_PING));
    },
    async close() {
      for (const s of open) s.destroy();
      await Promise.all(
        servers.map((s) => new Promise((r) => s.close(() => r(null)))),
      );
    },
  };

  const control = createTlsServer(own, (tls) => {
    track(tls);
    let head = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      tls.off("data", onData);
      const text = head.subarray(0, end).toString("latin1");
      const ok =
        text.startsWith(`GET ${RELAY_CONNECT_PATH} HTTP/1.1\r\n`) &&
        new RegExp(`\\r\\nupgrade: ${RELAY_UPGRADE}`, "i").test(text);
      relay.tokens.push(
        /\r\nauthorization: Bearer (\S+)/i.exec(text)?.[1] ?? "",
      );
      const status = ok ? (relay.refusals.shift() ?? 101) : 400;
      if (status !== 101) {
        tls.end(
          `HTTP/1.1 ${status} No\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      tls.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${RELAY_UPGRADE}\r\n\r\n`,
      );
      idle.add(tls);
      tls.once("close", () => idle.delete(tls));
      // An idle connection says nothing until a stream starts.
      tls.on("data", function quiet(this: TLSSocket) {
        if (idle.has(tls)) tls.destroy();
      });
    };
    tls.on("data", onData);
  });

  /**
   * Pipe a connection over an idle work connection: its line and its first
   * bytes in one write, as the relay writes them, then the rest.
   */
  const stream = (destinationPort: number) => (agent: Socket) => {
    track(agent);
    agent.once("data", (first: Buffer) => {
      agent.pause();
      const [work] = idle;
      if (!work) return agent.destroy();
      idle.delete(work);
      work.removeAllListeners("data");
      const line = proxyLine({
        family: "TCP4",
        source: o.source.address,
        destination: "127.0.0.1",
        sourcePort: o.source.port,
        destinationPort,
      });
      relay.lines.push(line);
      work.write(Buffer.concat([Buffer.from(line, "latin1"), first]));
      agent.pipe(work);
      work.pipe(agent);
      agent.once("close", () => work.destroy());
      work.once("close", () => agent.destroy());
      agent.resume();
    });
  };

  const agents = createNetServer(stream(RELAY_PORTS.tls));
  const http = createNetServer(stream(RELAY_PORTS.challenge));
  const servers: Server[] = [control, agents, http];
  relay.port = await listen(control);
  relay.agentPort = await listen(agents);
  relay.httpPort = await listen(http);
  return relay;
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
 * `fetch` for an agent: an https URL's host is reached at `port` on this
 * machine, as the relay host's DNS would lead to the relay, with its name
 * as the SNI and `ca` trusted for it. Each request on a connection of its
 * own, so each is a stream of its own.
 */
export function viaRelay(
  port: number,
  ca: string,
  peers: string[] = [],
): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.protocol !== "https:") return fetch(req);
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : null;
    const headers: Record<string, string> = Object.fromEntries(req.headers);
    headers.host = url.host;
    if (body) headers["content-length"] = String(body.length);
    return new Promise<Response>((resolve, reject) => {
      const out = httpsRequest(
        {
          host: "127.0.0.1",
          port,
          servername: url.hostname,
          ca,
          agent: false,
          method: req.method,
          path: `${url.pathname}${url.search}`,
          headers,
          signal: req.signal,
        },
        (res) => {
          const peer = (res.socket as TLSSocket).getPeerX509Certificate?.();
          if (peer) peers.push(peer.fingerprint256);
          const status = res.statusCode ?? 502;
          const empty =
            status === 204 || status === 304 || req.method === "HEAD";
          if (empty) res.resume();
          resolve(
            new Response(
              empty
                ? null
                : (Readable.toWeb(res) as ReadableStream<Uint8Array>),
              { status, headers: toHeaders(res.headers) },
            ),
          );
        },
      );
      out.on("error", reject);
      out.end(body ?? undefined);
    });
  };
}
