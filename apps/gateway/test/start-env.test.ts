// `midplane start` set up from the environment, in process, against the
// stand-in cloud and the stand-in ACME directory: it enrolls naming each
// database, then the gateway gets its certificate and serves over HTTPS;
// restarted, it serves what it wrote without enrolling or ordering again; a
// refused token orders no certificate, and a failure before enrollment
// leaves the volume empty and the token unused. The connection string that
// fails its test is kept, so no Postgres is needed but for the leak scan,
// which also runs a query on a database that answers.

import { createHash, randomBytes, X509Certificate } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { loadParser } from "@midplane/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadLinkedConfig } from "../src/config.ts";
import { log } from "../src/log.ts";
import { PromptClosed } from "../src/prompt.ts";
import { type RunningGateway, startLinked } from "../src/server.ts";
import { startConfig } from "../src/start.ts";
import { type FakeAcme, startFakeAcme } from "./fake-acme.ts";
import { type FakeCloud, startFakeCloud } from "./fake-cloud.ts";
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

/** A request over TLS to the gateway, by name, trusting only the authority's CA. */
function overTls(
  port: number,
  ca: string,
  o: {
    path: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: string; fingerprint: string }> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: o.path,
        method: o.method ?? "GET",
        servername: "gw.test",
        headers: { ...o.headers, host: `gw.test:${port}` },
        ca,
        agent: false,
      },
      (res) => {
        const fingerprint = createHash("sha256")
          .update((res.socket as TLSSocket).getPeerCertificate().raw)
          .digest("hex");
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () =>
          done({ status: res.statusCode ?? 0, body, fingerprint }),
        );
      },
    );
    req.on("error", fail);
    req.end(o.body);
  });
}

const fingerprintOf = (pem: string) =>
  createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");

/** Every file under `dir`, by path. */
const filesIn = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

describe("midplane start, from the environment", { timeout: 30_000 }, () => {
  let cloud: FakeCloud;
  let acme: FakeAcme;
  let base: string;
  /** Fails its test: nothing listens on port 1. */
  const password = `pw-${randomBytes(8).toString("hex")}`;
  const unreachable = `postgres://agent:${password}@127.0.0.1:1/shop`;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    acme = await startFakeAcme();
    base = mkdtempSync(join(tmpdir(), "midplane-start-env-"));
    await loadParser();
  });
  afterAll(async () => {
    await acme?.close();
    await cloud?.close();
  });

  const enrolls = () =>
    cloud.bodies.filter((b) => b.path === "/link/v1/enroll").length;

  /** The environment a platform's secrets, or an env file, would hold. */
  const environment = async (
    token: string,
    databases: Record<string, string> = { MIDPLANE_DSN_SHOP: unreachable },
  ): Promise<NodeJS.ProcessEnv> => ({
    MIDPLANE_CLOUD_URL: cloud.url,
    MIDPLANE_ENROLLMENT_TOKEN: token,
    MIDPLANE_URL: "https://gw.test",
    MIDPLANE_PORT: String(await freePort()),
    MIDPLANE_ACME_DIRECTORY: acme.url,
    ...databases,
  });

  /**
   * `start` in a volume, as the image runs it (nothing mounted at the
   * config's place), until the gateway serves. Throws what setup or the
   * gateway says.
   */
  const start = async (
    volume: string,
    env: NodeJS.ProcessEnv,
    o: { fetch?: typeof fetch } = {},
  ): Promise<RunningGateway> => {
    const path = await startConfig({
      config: join(base, "nothing-mounted", "midplane.yaml"),
      dir: volume,
      env,
      log,
      inContainer: false,
      acme: { httpPort: await freePort() },
      ...o,
    });
    const config = loadLinkedConfig(path, env);
    // A volume set up before answers the challenge where its config says.
    if (config.tls?.kind === "acme") acme.challengePort = config.tls.httpPort;
    return startLinked(config, {
      certificates: { timing: { polling: POLLING } },
    });
  };

  // protects=one start with the environment enrolls naming each database, gets the certificate, writes no connection string, and serves HTTPS with that certificate;
  // fails_when=a DSN file is written, the config holds the string instead of its variable, enrollment misses the database, no certificate is kept, or the gateway serves another;
  // no_claim=Let's Encrypt or Docker (the package smoke runs the image against Pebble)
  it("sets up, gets the certificate, enrolls, and serves over HTTPS", async () => {
    const volume = join(base, "first");
    mkdirSync(volume); // a container's volume: there and empty
    const orders = acme.newOrders;
    const env = await environment(cloud.enrollmentToken());
    const gateway = await start(volume, env);
    try {
      expect(acme.newOrders).toBe(orders + 1);
      expect(
        JSON.parse(
          cloud.bodies.findLast((b) => b.path === "/link/v1/enroll")?.body ??
            "{}",
        ).databases,
      ).toEqual(["shop"]);
      // What setup wrote; the gateway adds its audit log and bundle cache.
      expect(
        readdirSync(volume)
          .filter((f) => !/^(audit\.db|bundle\.jws)/.test(f))
          .sort(),
      ).toEqual(["acme", "identity.json", "midplane.yaml", "secrets"]);
      expect(readdirSync(join(volume, "secrets"))).toEqual(["mask-salt"]);
      const config = parseYaml(
        readFileSync(join(volume, "midplane.yaml"), "utf8"),
      );
      expect(config.databases).toEqual({
        shop: { dsn: { env: "MIDPLANE_DSN_SHOP" } },
      });
      expect(config.tls).toEqual({
        acme: expect.objectContaining({ directory_url: acme.url }),
      });

      const cert = readFileSync(join(volume, "acme", "cert.pem"), "utf8");
      const port = Number(env.MIDPLANE_PORT);
      const got = await overTls(port, acme.ca, { path: "/healthz" });
      expect(got).toEqual({
        status: 200,
        body: "ok",
        fingerprint: fingerprintOf(cert),
      });
      // It connects with the string in the variable, and reports it unreachable.
      await vi.waitFor(
        () =>
          expect(cloud.statuses.at(-1)?.database_health?.shop).toMatchObject({
            ok: false,
            code: "ECONNREFUSED",
          }),
        { timeout: 10_000 },
      );
    } finally {
      await gateway.close();
    }
  });

  // protects=the same container restarted serves the volume: no enrollment request and no new certificate, with the token still in the environment;
  // fails_when=a restart enrolls again (and fails on the used token), orders a certificate, or serves a different one;
  // no_claim=a certificate near its end (renewal is certificates.ts's)
  it("restarted, serves what it wrote without enrolling or ordering again", async () => {
    const volume = join(base, "restart");
    const env = await environment(cloud.enrollmentToken());
    await (await start(volume, env)).close();
    const before = { enrolls: enrolls(), orders: acme.newOrders };
    const cert = readFileSync(join(volume, "acme", "cert.pem"), "utf8");

    const again = await start(volume, env);
    try {
      expect(enrolls()).toBe(before.enrolls);
      expect(acme.newOrders).toBe(before.orders);
      const got = await overTls(Number(env.MIDPLANE_PORT), acme.ca, {
        path: "/healthz",
      });
      expect(got.status).toBe(200);
      expect(got.fingerprint).toBe(fingerprintOf(cert));
    } finally {
      await again.close();
    }
  });

  // protects=a token the cloud refuses orders no certificate and leaves the volume empty; a stop before enrolling removes what was written and leaves the token unused; the config is written only once enrolled;
  // fails_when=a certificate is ordered before the cloud accepts the token (a restart loop then spends Let's Encrypt's duplicate-certificate limit), a file survives, the token is spent so the next start can't enroll, or midplane.yaml exists while enrolling (a setup killed then would be served forever);
  // no_claim=a stop during enrollment itself (setup says the cloud may have enrolled it, as interactive setup does)
  it("orders no certificate for a refused token, and a stop before enrolling leaves the token unused", async () => {
    const volume = join(base, "refused");
    mkdirSync(volume);
    const orders = acme.newOrders;
    await expect(
      start(volume, await environment(`mpe1_${"A".repeat(86)}`)),
    ).rejects.toThrow(
      "enrollment refused (401): unknown token\nSetup removed the files it wrote.",
    );
    expect(readdirSync(volume)).toEqual([]);
    expect(acme.newOrders).toBe(orders);

    // Stopped once setup has written its files, as `docker stop` would.
    const env = await environment(cloud.enrollmentToken());
    const before = enrolls();
    const stop = new AbortController();
    await expect(
      startConfig({
        config: join(base, "nothing-mounted", "midplane.yaml"),
        dir: volume,
        env,
        log: (fields) => {
          if (fields.database === "shop") stop.abort();
        },
        signal: stop.signal,
        inContainer: false,
        acme: { httpPort: await freePort() },
      }),
    ).rejects.toThrow(PromptClosed);
    expect(readdirSync(volume)).toEqual([]);
    expect(enrolls()).toBe(before);

    // The token was never spent: the next start enrolls with it. Until it
    // has, the volume holds no config, so a setup killed meanwhile is never
    // served as if it were set up.
    let configWhileEnrolling: boolean | null = null;
    await (
      await start(volume, env, {
        fetch: (url, init) => {
          if (String(url).endsWith("/link/v1/enroll")) {
            configWhileEnrolling = existsSync(join(volume, "midplane.yaml"));
          }
          return fetch(url, init);
        },
      })
    ).close();
    expect(enrolls()).toBe(before + 1);
    expect(configWhileEnrolling).toBe(false);
  });

  // protects=a certificate the authority refuses after enrolling is got at a later start, with no new token and no second enrollment, and the gateway's last word is why;
  // fails_when=the refusal undoes the enrollment, a restart sets up again (and fails on the used token), or the next start doesn't order;
  // no_claim=Let's Encrypt's limits on failed validations (one account, kept on the volume, tries again at each start)
  it("gets a certificate refused after enrolling at the next start, without enrolling again", async () => {
    const volume = join(base, "dns");
    const env = await environment(cloud.enrollmentToken());
    acme.failValidation = {
      type: "urn:ietf:params:acme:error:dns",
      detail: "DNS problem: NXDOMAIN looking up A for gw.test",
    };
    try {
      await expect(start(volume, env)).rejects.toThrow(
        "the DNS for gw.test doesn't point at this server",
      );
    } finally {
      acme.failValidation = null;
    }
    const enrolled = enrolls();
    expect(readdirSync(volume)).toEqual(
      expect.arrayContaining(["identity.json", "midplane.yaml"]),
    );

    const orders = acme.newOrders;
    const gateway = await start(volume, env);
    try {
      expect(enrolls()).toBe(enrolled);
      expect(acme.newOrders).toBe(orders + 1);
      const got = await overTls(Number(env.MIDPLANE_PORT), acme.ca, {
        path: "/healthz",
      });
      expect(got.status).toBe(200);
    } finally {
      await gateway.close();
    }
  });

  describe.skipIf(!hasPostgres)("with a database that answers", () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createDatabase(
        "CREATE TABLE notes (id int PRIMARY KEY, body text); INSERT INTO notes VALUES (1, 'hello');",
        (role) => `GRANT SELECT ON notes TO ${role};`,
      );
    }, 60_000);
    afterAll(async () => {
      await db?.drop();
    });

    // protects=invariant 9 for setup from the environment: no connection string, nor its password, in the volume, in any log line (setup's or the gateway's, across a failed start, a first start, a query and a restart), or in anything sent to the cloud;
    // fails_when=a string or password is written to a file, logged, or sent in enrollment, a status, a catalog or an audit record;
    // no_claim=what the platform does with its environment (its secret store), or what Docker's own logs hold (the package smoke scans `docker logs`)
    it("serves a query, and leaks no connection string to the volume, a log line or the cloud", async () => {
      const volume = join(base, "leak");
      mkdirSync(volume);
      const env = await environment(cloud.enrollmentToken(), {
        MIDPLANE_DSN_NOTES: db.agentDsn,
        MIDPLANE_DSN_SHOP: unreachable,
      });
      let logged = "";
      const capture = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk) => {
          logged += String(chunk);
          return true;
        });
      let gateway: RunningGateway | null = null;
      try {
        // A failed start first, then the one that serves, then a restart.
        acme.failValidation = {
          type: "urn:ietf:params:acme:error:dns",
          detail: "no",
        };
        await start(volume, env).catch(() => {});
        acme.failValidation = null;
        await (await start(volume, env)).close();
        gateway = await start(volume, env);
        const { version } = await cloud.publish({
          notes: { table_access: { tables: { "public.notes": "read" } } },
        });
        await vi.waitFor(
          () =>
            expect(
              cloud.statuses.some(
                (s) => s.bundle_version === version && s.state === "enforcing",
              ),
            ).toBe(true),
          { timeout: 15_000 },
        );
        const agent = await cloud.agentToken({
          audience: "https://gw.test/mcp",
          databases: { notes: "read" },
        });
        const reply = await overTls(Number(env.MIDPLANE_PORT), acme.ca, {
          path: "/mcp",
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
            authorization: `Bearer ${agent}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "query",
              arguments: { sql: "SELECT body FROM notes", database: "notes" },
            },
          }),
        });
        expect(reply.status).toBe(200);
        expect(reply.body).toContain('"rows":[["hello"]]');
        await vi.waitFor(() => expect(cloud.catalogs.has("notes")).toBe(true));
        await vi.waitFor(
          () =>
            expect(
              [...cloud.audit.values()].some((m) =>
                [...m.values()].some(
                  (r) =>
                    r.event === "ATTEMPTED" &&
                    r.statement === "SELECT body FROM notes",
                ),
              ),
            ).toBe(true),
          { timeout: 10_000 },
        );
      } finally {
        await gateway?.close();
        capture.mockRestore();
      }
      const lines = logged.trim().split("\n");
      // Setup's own lines: the test of each string, but never the string.
      expect(lines.map((l) => JSON.parse(l).msg)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^ok: database mp_gw_\w+ on [^,]+, 1 table$/),
          "connection refused (ECONNREFUSED)",
        ]),
      );

      const secrets = [
        db.agentDsn,
        new URL(db.agentDsn).password,
        unreachable,
        password,
      ];
      const places = [
        { where: "the log", text: logged },
        ...filesIn(volume).map((f) => ({
          where: f,
          text: readFileSync(f, "latin1"),
        })),
        ...cloud.bodies.map((b) => ({ where: b.path, text: b.body })),
      ];
      expect(places.some((p) => p.where.endsWith("audit.db"))).toBe(true);
      for (const { where, text } of places) {
        for (const secret of secrets) {
          expect(text, `${where} holds ${secret}`).not.toContain(secret);
        }
      }
    });
  });
});
