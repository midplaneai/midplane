// A gateway with `tls.acme` end to end, against Postgres and the stand-in
// ACME directory: it gets its certificate before it listens and serves MCP
// over HTTPS with it; a restart reuses it; inside its last 30 days the check
// renews it and new connections get the new one while an open MCP
// connection goes on, in the same process; and its challenge listener
// answers /mcp with an empty 404, even for a token the gateway accepts.

import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Agent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { loadParser } from "@midplane/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateSigningKey, mintToken } from "../src/auth.ts";
import { parseConfig } from "../src/config.ts";
import { type RunningGateway, startLocal } from "../src/server.ts";
import { type FakeAcme, startFakeAcme } from "./fake-acme.ts";
import { createDatabase, hasPostgres, type TestDatabase } from "./harness.ts";

const POLLING = { firstMs: 5, limitMs: 5000 };

function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

const fingerprintOf = (raw: Buffer) =>
  createHash("sha256").update(raw).digest("hex");

interface Answer {
  status: number;
  body: string;
  /** The certificate this connection was served. */
  fingerprint: string;
  /** Whether the request went over a connection opened before. */
  reused: boolean;
}

describe.skipIf(!hasPostgres)("a gateway with tls.acme", () => {
  let db: TestDatabase;
  let acme: FakeAcme;
  let dir: string;
  let port: number;
  let httpPort: number;
  let privateJwk: Record<string, unknown>;

  beforeAll(async () => {
    await loadParser();
    db = await createDatabase(
      "CREATE TABLE notes (id int PRIMARY KEY, body text); INSERT INTO notes VALUES (1, 'hello');",
      (role) => `GRANT SELECT ON notes TO ${role};`,
    );
    acme = await startFakeAcme();
    dir = mkdtempSync(join(tmpdir(), "midplane-acme-gw-"));
    port = await freePort();
    httpPort = await freePort();
    acme.challengePort = httpPort;
    const keys = await generateSigningKey();
    privateJwk = keys.privateJwk as Record<string, unknown>;
    writeFileSync(join(dir, "verify-key.json"), JSON.stringify(keys.publicJwk));
  }, 60_000);

  afterAll(async () => {
    await acme?.close();
    await db?.drop();
  });

  const start = (): Promise<RunningGateway> => {
    const text = JSON.stringify({
      listen: { host: "127.0.0.1", port },
      public_urls: [`https://gw.test:${port}`],
      tls: { acme: { http_port: httpPort, directory_url: acme.url } },
      auth: { issuer: "midplane-test", public_key_file: "verify-key.json" },
      audit: { file: "audit.db" },
      databases: {
        main: {
          dsn: { env: "NOTES_DSN" },
          policy: { table_access: { default: "read" } },
        },
      },
    });
    return startLocal(
      parseConfig(text, join(dir, "midplane.yaml"), { NOTES_DSN: db.agentDsn }),
      { certificates: { timing: { polling: POLLING } } },
    );
  };

  const token = () =>
    mintToken({
      privateJwk: privateJwk as Parameters<typeof mintToken>[0]["privateJwk"],
      issuer: "midplane-test",
      audience: `https://gw.test:${port}/mcp`,
      project: "local",
      sub: "agent-user",
      clientId: "test-client",
      grantId: `grant-${Date.now()}`,
      databases: { main: "read" },
      ttlSeconds: 300,
    });

  /** One MCP tools/call over HTTPS, trusting only the authority's CA. */
  const call = (
    bearer: string,
    sql: string,
    agent: HttpsAgent | false = false,
  ): Promise<Answer> =>
    new Promise((done, fail) => {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "query", arguments: { sql } },
      });
      const req = httpsRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          servername: "gw.test",
          ca: acme.ca,
          agent,
          headers: {
            host: `gw.test:${port}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
            authorization: `Bearer ${bearer}`,
          },
        },
        (res) => {
          const fingerprint = fingerprintOf(
            (res.socket as TLSSocket).getPeerCertificate().raw,
          );
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (d) => {
            text += d;
          });
          res.on("end", () =>
            done({
              status: res.statusCode ?? 0,
              body: text,
              fingerprint,
              reused: req.reusedSocket,
            }),
          );
        },
      );
      req.on("error", fail);
      req.end(body);
    });

  /** A plain-HTTP request to the challenge listener; its status, type and body. */
  const challenge = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    new Promise<{ status: number; type: string | null; body: string }>(
      (done, fail) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: httpPort,
            path,
            method,
            headers,
            agent: false as unknown as Agent,
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (d) => {
              text += d;
            });
            res.on("end", () =>
              done({
                status: res.statusCode ?? 0,
                type: res.headers["content-type"] ?? null,
                body: text,
              }),
            );
          },
        );
        req.on("error", fail);
        req.end(body);
      },
    );

  // protects=a gateway with tls.acme gets its certificate before listening and serves MCP over HTTPS with it; a restart with more than 30 days left orders nothing;
  // fails_when=it listens without one, serves another, or orders again after a restart;
  // no_claim=Let's Encrypt (Pebble in the package smoke) or a restart in another process
  it("serves MCP over HTTPS with the certificate it got, and a restart orders none", async () => {
    const orders = acme.newOrders;
    const first = await start();
    let served: string;
    try {
      expect(acme.newOrders).toBe(orders + 1);
      const leaf = new X509Certificate(first.certificates?.current.cert ?? "");
      served = fingerprintOf(leaf.raw);
      const r = await call(await token(), "SELECT body FROM notes");
      expect(r.status).toBe(200);
      expect(r.body).toContain("hello");
      expect(r.fingerprint).toBe(served);
    } finally {
      await first.close();
    }

    const again = await start();
    try {
      expect(acme.newOrders).toBe(orders + 1);
      const r = await call(await token(), "SELECT body FROM notes");
      expect(r.body).toContain("hello");
      expect(r.fingerprint).toBe(served);
    } finally {
      await again.close();
    }
  });

  // protects=inside its last 30 days the next check renews the certificate; new connections get it with no restart, and an open MCP connection goes on;
  // fails_when=new connections still get the old certificate, the gateway restarts, or the open connection fails;
  // no_claim=the 12-hour timer itself (certificates.ts schedules check() on it) or Let's Encrypt
  it("renews inside 30 days, for new connections, while an open one goes on", async () => {
    // Without the stored one, the start orders one inside its last 30 days.
    rmSync(join(dir, "acme", "cert.pem"));
    acme.validDays = 20;
    const gateway = await start();
    const agent = new HttpsAgent({ keepAlive: true, maxSockets: 1 });
    try {
      const bearer = await token();
      const old = fingerprintOf(
        new X509Certificate(gateway.certificates?.current.cert ?? "").raw,
      );
      const before = await call(bearer, "SELECT body FROM notes", agent);
      expect(before.body).toContain("hello");
      expect(before.fingerprint).toBe(old);

      const orders = acme.newOrders;
      acme.validDays = 90;
      await gateway.certificates?.check();
      expect(acme.newOrders).toBe(orders + 1);
      const renewed = fingerprintOf(
        new X509Certificate(gateway.certificates?.current.cert ?? "").raw,
      );
      expect(renewed).not.toBe(old);

      // The open connection: reused, on the certificate it began with.
      const open = await call(bearer, "SELECT body FROM notes", agent);
      expect(open).toMatchObject({
        status: 200,
        reused: true,
        fingerprint: old,
      });
      expect(open.body).toContain("hello");
      // A new connection: the renewed certificate.
      const fresh = await call(bearer, "SELECT body FROM notes");
      expect(fresh).toMatchObject({
        status: 200,
        reused: false,
        fingerprint: renewed,
      });
    } finally {
      agent.destroy();
      acme.validDays = 90;
      await gateway.close();
    }
  });

  // protects=the TLS rule: the plain-HTTP challenge listener never handles MCP, not even with a token the gateway accepts;
  // fails_when=/mcp on the challenge port answers anything but an empty 404, or a pending-token path answers outside an order;
  // no_claim=what reaches the server's port 80 besides the listener
  it("answers /mcp on the challenge port with an empty 404, even with a valid token", async () => {
    const gateway = await start();
    try {
      const bearer = await token();
      // The token is good: the HTTPS listener runs the query.
      expect((await call(bearer, "SELECT body FROM notes")).body).toContain(
        "hello",
      );
      const auth = { authorization: `Bearer ${bearer}` };
      const mcp = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      });
      for (const [method, path, headers, body] of [
        ["GET", "/mcp", auth, undefined],
        [
          "POST",
          "/mcp",
          {
            ...auth,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          mcp,
        ],
        ["GET", "/.well-known/acme-challenge/unknown-token", auth, undefined],
        ["GET", "/healthz", {}, undefined],
      ] as const) {
        expect(
          await challenge(method, path, { ...headers }, body),
          `${method} ${path}`,
        ).toEqual({ status: 404, type: null, body: "" });
      }
    } finally {
      await gateway.close();
    }
  });
});
