// A TCP proxy in front of Postgres, for a database that can't be reached and
// then can: while refusing, nothing listens on its port (ECONNREFUSED);
// while forwarding, each connection is piped to the target. Refusing again
// drops every connection it carries.

import { connect, createServer, type Server, type Socket } from "node:net";

export interface TcpProxy {
  port: number;
  /** A DSN like `dsn`, through this proxy. */
  dsn(dsn: string): string;
  forward(): Promise<void>;
  refuse(): Promise<void>;
}

/** A proxy to `target` (`host:port`), refusing until told to forward. */
export async function startProxy(target: {
  host: string;
  port: number;
}): Promise<TcpProxy> {
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => s.destroy());
  };
  let server: Server | null = null;
  // A free port, held by nothing until the proxy forwards.
  const port = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

  return {
    port,
    dsn(dsn) {
      const u = new URL(dsn);
      u.hostname = "127.0.0.1";
      u.port = String(port);
      return u.toString();
    },
    async forward() {
      if (server) return;
      const s = createServer((client) => {
        const upstream = connect(target.port, target.host);
        track(client);
        track(upstream);
        client.pipe(upstream);
        upstream.pipe(client);
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
      });
      server = s;
      await new Promise<void>((resolve) =>
        s.listen(port, "127.0.0.1", resolve),
      );
    },
    async refuse() {
      const s = server;
      server = null;
      const closed = s
        ? new Promise<void>((resolve) => s.close(() => resolve()))
        : Promise.resolve();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
