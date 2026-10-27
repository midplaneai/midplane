// A gateway reached through a relay, end to end against Postgres, a
// stand-in cloud, the stand-in ACME directory and a stand-in relay: it
// enrolls, opens its work connections with the link token, gets its
// certificate through them (port 80), then serves MCP on streams whose
// PROXY line names 443, as the agent the line names. A stream naming 80
// reaches the challenge handler and nothing else. The real relay and cloud
// are the cloud's tests (relay-gateway.e2e.test.ts).

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  type X509Certificate,
} from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { type AddressInfo, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { loadParser } from "@midplane/core";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseLinkedConfig } from "../src/config.ts";
import { type RunningGateway, startLinked } from "../src/server.ts";
import { type FakeAcme, startFakeAcme } from "./fake-acme.ts";
import { type FakeCloud, startFakeCloud } from "./fake-cloud.ts";
import { createDatabase, hasPostgres, type TestDatabase } from "./harness.ts";
import {
  type StandInRelay,
  startStandInRelay,
  viaRelay,
} from "./stand-in-relay.ts";

const CONTROL = "relay.eu.relay.test";
const HOST = "gw-k3m9x2qa.eu.relay.test";
const RESOURCE = `https://${HOST}/mcp`;
const AGENT = { address: "203.0.113.7", port: 51234 };
const POLLING = { firstMs: 5, limitMs: 5000 };

const spkiFingerprint = (key: KeyObject) =>
  createHash("sha256")
    .update(key.export({ type: "spki", format: "der" }))
    .digest("hex");

async function waitFor(
  what: string,
  check: () => boolean,
  ms = 10_000,
): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Whether a TLS handshake for the relay host completes through the relay. */
function handshake(port: number, ca: string): Promise<"secure" | "closed"> {
  return new Promise((resolve) => {
    const tls = tlsConnect({ host: "127.0.0.1", port, servername: HOST, ca });
    tls.once("secureConnect", () => {
      tls.destroy();
      resolve("secure");
    });
    tls.on("error", () => {});
    tls.once("close", () => resolve("closed"));
  });
}

/** Plain HTTP on the relay's port 80, as sent: the status and body that come back. */
function onPort80(
  port: number,
  request: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const s = tcpConnect(port, "127.0.0.1", () => s.write(request));
    let got = "";
    s.on("data", (d: Buffer) => {
      got += d.toString("latin1");
    });
    s.on("error", () => {});
    s.once("close", () => {
      const end = got.indexOf("\r\n\r\n");
      resolve({
        status: Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? 0),
        body: end < 0 ? "" : got.slice(end + 4),
      });
    });
  });
}

describe.skipIf(!hasPostgres)(
  "a gateway through a relay",
  { timeout: 30_000 },
  () => {
    let db: TestDatabase;
    let cloud: FakeCloud;
    let acme: FakeAcme;
    let relay: StandInRelay;
    let gate: Server;
    let dir: string;
    let gw: RunningGateway;
    /** Each request the HTTPS server got, and who it says sent it. */
    const requests: { url: string; from: string | undefined }[] = [];
    const env: NodeJS.ProcessEnv = { SALT: "s".repeat(32) };
    let release: () => void = () => {};
    const opened = new Promise<void>((r) => {
      release = r;
    });

    beforeAll(async () => {
      await loadParser();
      db = await createDatabase(
        "CREATE TABLE users (id int PRIMARY KEY, name text); INSERT INTO users VALUES (1, 'Alice'), (2, 'Bob');",
        (role) => `GRANT SELECT ON users TO ${role};`,
      );
      env.DSN = db.agentDsn;
      cloud = await startFakeCloud();
      relay = await startStandInRelay({ control: CONTROL, source: AGENT });
      acme = await startFakeAcme({ challengePort: relay.httpPort });
      // The directory, held until the test opens it: so the gateway's start
      // can be seen between its work connections and its certificate.
      gate = createHttpServer((req, res) => {
        void opened.then(async () => {
          const up = await fetch(acme.url, {
            headers: { "user-agent": req.headers["user-agent"] ?? "" },
          });
          res.writeHead(up.status, { "content-type": "application/json" });
          res.end(await up.text());
        });
      });
      await new Promise<void>((r) => gate.listen(0, "127.0.0.1", r));
      dir = mkdtempSync(join(tmpdir(), "midplane-relayed-"));
      env.ENROLL = cloud.enrollmentToken();
    }, 60_000);

    afterAll(async () => {
      await gw?.close();
      await relay?.close();
      await acme?.close();
      gate?.close();
      await cloud?.close();
      await db?.drop();
    });

    // protects=a relayed gateway starts in order (identity, work connections with the link token, the certificate through them, serving), reports its connections to the cloud while the certificate waits, closes a 443 stream before it has a certificate, then serves MCP on relayed streams with the certificate it got through the relay, as the agent the PROXY line names, and reports its connections up;
    // fails_when=it wants a certificate before its work connections, serves TLS without one, binds a challenge port, serves a certificate it didn't get through the relay or whose key isn't its own, sees the relay as the client, or reports none idle;
    // no_claim=the real relay (the cloud's relay-gateway tests); the fake ACME directory stands in for Let's Encrypt
    it("opens its work connections, gets its certificate through them, then serves MCP on relayed streams", async () => {
      const text = JSON.stringify({
        listen: { host: "127.0.0.1", port: 0 },
        relay: { control: CONTROL },
        public_url: `https://${HOST}`,
        tls: {
          acme: {
            directory_url: `http://127.0.0.1:${(gate.address() as AddressInfo).port}/dir`,
          },
        },
        audit: { file: "audit.db" },
        mask_salt: { env: "SALT" },
        link: {
          cloud_url: cloud.url,
          identity: { file: "identity.json" },
          enrollment_token: { env: "ENROLL" },
        },
        databases: { main: { dsn: { env: "DSN" } } },
      });
      const path = join(dir, "midplane.yaml");
      writeFileSync(path, text);
      const starting = startLinked(parseLinkedConfig(text, path, env), {
        retry: { minMs: 50, maxMs: 200, cutMs: 200 },
        relay: {
          connect: { host: "127.0.0.1", port: relay.port },
          ca: relay.ca,
        },
        certificates: { timing: { polling: POLLING } },
      });

      // Enrolled, then 4 idle work connections with one link token, while
      // the certificate waits on the directory.
      await waitFor("4 idle work connections", () => relay.idle() === 4);
      expect(cloud.gatewayId).not.toBeNull();
      expect(cloud.registered).toEqual([RESOURCE]);
      expect(new Set(relay.tokens).size).toBe(1);
      expect(relay.tokens[0]).toMatch(/\S{16,}/);
      // No certificate yet: a TLS stream closes, and is replaced.
      expect(await handshake(relay.agentPort, acme.ca)).toBe("closed");
      await waitFor("a replacement", () => relay.idle() === 4);

      // Syncing already: the cloud hears the work connections are up while
      // the certificate waits, as it would hear a refusal.
      await waitFor("a status naming the relay", () =>
        cloud.statuses.some((st) => (st.relay?.idle ?? 0) > 0),
      );

      release();
      gw = await starting;
      (
        gw.server as unknown as {
          on(
            e: "request",
            f: (r: {
              url?: string;
              socket: { remoteAddress?: string };
            }) => void,
          ): void;
        }
      ).on("request", (r) =>
        requests.push({ url: r.url ?? "", from: r.socket.remoteAddress }),
      );

      // Its certificate, through the relay's port 80: the challenge was
      // fetched there, and the key never left its folder.
      expect(acme.fetches).toEqual([expect.objectContaining({ status: 200 })]);
      expect(relay.lines.filter((l) => / 80\r\n$/.test(l))).toHaveLength(1);
      const issued = acme.issued.at(-1) as X509Certificate;
      expect(issued.checkHost(HOST)).toBe(HOST);
      const key = createPrivateKey(
        readFileSync(join(dir, "acme", "key.pem"), "utf8"),
      );
      expect(spkiFingerprint(createPublicKey(key))).toBe(
        spkiFingerprint(issued.publicKey),
      );
      // Nothing listens for challenges: its only port is the loopback one.
      expect(gw.listener).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);

      await cloud.publish({
        main: { table_access: { tables: { "public.users": "read" } } },
      });
      await waitFor(
        "the bundle",
        () => gw.gateway.enforcement.state === "enforcing",
      );

      const peers: string[] = [];
      const token = await cloud.agentToken({
        audience: RESOURCE,
        databases: { main: "read" },
      });
      const client = new Client(
        { name: "e2e", version: "1" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      await client.connect(
        new StreamableHTTPClientTransport(new URL(RESOURCE), {
          fetch: viaRelay(relay.agentPort, acme.ca, peers),
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      try {
        const r = (await client.callTool({
          name: "query",
          arguments: { sql: "SELECT name FROM users ORDER BY id" },
        })) as { structuredContent?: { rows: unknown[][] } };
        expect(r.structuredContent?.rows).toEqual([["Alice"], ["Bob"]]);
      } finally {
        await client.close();
      }
      // Served with the certificate it got, to the agent the line named.
      expect(new Set(peers)).toEqual(new Set([issued.fingerprint256]));
      expect(requests.length).toBeGreaterThan(0);
      expect(new Set(requests.map((r) => r.from))).toEqual(
        new Set([AGENT.address]),
      );
      // Each stream's connection was replaced; the status says so.
      await waitFor("4 idle again", () => relay.idle() === 4);
      await waitFor(
        "a status with the relay",
        () => cloud.statuses.at(-1)?.relay?.idle === 4,
      );
      expect(cloud.statuses.at(-1)?.relay).toEqual({ idle: 4, refused: null });
    });

    // protects=a stream whose PROXY line names port 80 reaches the challenge handler and nothing else: never the MCP app, its metadata or its probes, even with /mcp and a valid agent token;
    // fails_when=port 80 answers anything but a pending challenge token (with an empty 404 otherwise), or a request on it reaches the HTTPS server's app or the audit log;
    // no_claim=what the real relay lets through its port 80 (only challenge GETs, the cloud's relay tests)
    it("sends a stream naming port 80 to the challenge handler only, even with /mcp and a valid token", async () => {
      const token = await cloud.agentToken({
        audience: RESOURCE,
        databases: { main: "read" },
      });
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "query", arguments: { sql: "SELECT name FROM users" } },
      });
      const before = requests.length;
      const head = gw.audit.head();
      for (const request of [
        `POST /mcp HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMCP-Protocol-Version: 2025-11-25\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
        `GET /mcp HTTP/1.1\r\nHost: ${HOST}\r\nAuthorization: Bearer ${token}\r\nConnection: close\r\n\r\n`,
        `GET /.well-known/oauth-protected-resource/mcp HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`,
        `GET /healthz HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`,
        `GET /.well-known/acme-challenge/not-pending HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`,
      ]) {
        expect(await onPort80(relay.httpPort, request)).toEqual({
          status: 404,
          body: "",
        });
      }
      expect(requests.length).toBe(before);
      expect(gw.audit.head()).toEqual(head);
      // The same token on a TLS stream reaches MCP.
      const res = await viaRelay(relay.agentPort, acme.ca)(RESOURCE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Alice");
      expect(requests.length).toBe(before + 1);
    });
  },
);
