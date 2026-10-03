// `midplane setup` before its first question: the flags, the folder, the
// port and the certificate, each checked before the token can be spent; the
// names it suggests; and the config it writes, which the gateway loads.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseLinkedConfig } from "../src/config.ts";
import {
  certificateProblem,
  choosePort,
  dsnDatabase,
  dsnHost,
  planSetup,
  prepareSetup,
  SetupError,
  type SetupFlags,
  setupYaml,
  suggestDatabaseId,
} from "../src/setup.ts";

const TOKEN = `mpe1_${"A".repeat(86)}`;
const flags = (more: SetupFlags = {}): SetupFlags => ({
  cloud: "https://eu.app.midplane.ai",
  token: TOKEN,
  ...more,
});
const refusal = (more: SetupFlags) => {
  try {
    planSetup(flags(more), "gw-test0000");
  } catch (err) {
    expect(err).toBeInstanceOf(SetupError);
    return (err as Error).message;
  }
  throw new Error("planned");
};

describe("the flags", () => {
  it("take a cloud, a token and database ids, and name the folder after the gateway", () => {
    const plan = planSetup(
      flags({
        cloud: "https://eu.app.midplane.ai/x",
        database: ["shop", "orders"],
      }),
      "gw-k3m9x2qa",
    );
    expect(plan).toMatchObject({
      cloudUrl: "https://eu.app.midplane.ai",
      databases: ["shop", "orders"],
      server: null,
      port: null,
      dir: "gw-k3m9x2qa",
      start: true,
    });
    expect(planSetup(flags({ cloud: "http://127.0.0.1:3000" })).cloudUrl).toBe(
      "http://127.0.0.1:3000",
    );
    expect(
      planSetup(flags({ url: "https://gw.example.com/mcp", "no-start": true }))
        .server,
    ).toEqual({ url: "https://gw.example.com", tlsDir: "/etc/midplane/tls" });
  });

  it("refuse a bad token, an http cloud off this machine, and bad ids or ports", () => {
    expect(refusal({ token: "mpe1_short" })).toMatch(
      /not a Midplane enrollment token/,
    );
    expect(refusal({ token: undefined })).toMatch(/--cloud <url> and --token/);
    expect(refusal({ cloud: "http://eu.app.midplane.ai" })).toMatch(/https/);
    expect(refusal({ cloud: "eu.app.midplane.ai" })).toMatch(/Cloud's URL/);
    expect(refusal({ database: ["Shop"] })).toMatch(
      /--database Shop: a name starts/,
    );
    expect(refusal({ database: ["shop", "shop"] })).toMatch(/listed twice/);
    for (const port of ["0", "65536", "80a", "-1"]) {
      expect(refusal({ port })).toMatch(/--port must be a port number/);
    }
    expect(refusal({ "tls-dir": "/tls" })).toMatch(/--tls-dir goes with --url/);
  });

  it("take a server's URL as the dashboard does: https, a host and no more", () => {
    expect(refusal({ url: "http://gw.example.com" })).toMatch(/https:\/\//);
    expect(refusal({ url: "https://u:p@gw.example.com" })).toMatch(
      /credentials/,
    );
    expect(refusal({ url: "https://gw.example.com/?a=1" })).toMatch(/query/);
    expect(refusal({ url: "https://gw.example.com/#x" })).toMatch(/fragment/);
    expect(refusal({ url: "https://gw.example.com/db" })).toMatch(/host only/);
    expect(refusal({ url: "gw.example.com" })).toMatch(/full URL/);
  });
});

describe("the folder", () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "midplane-setup-"));
  });
  // With no certificate, a folder setup may use fails one check later.
  const prepare = (dir: string) =>
    prepareSetup(
      planSetup(
        flags({
          dir: join(base, dir),
          url: "https://gw.example.com",
          "tls-dir": join(base, "no-tls"),
        }),
      ),
    );

  it("may be missing or empty, a container's volume, but not hold anything", async () => {
    mkdirSync(join(base, "empty"));
    await expect(prepare("missing")).rejects.toThrow(/can't read .*tls\.crt/);
    await expect(prepare("empty")).rejects.toThrow(/can't read .*tls\.crt/);
    mkdirSync(join(base, "full"));
    writeFileSync(join(base, "full", "notes.txt"), "");
    await expect(prepare("full")).rejects.toThrow(/full isn't empty/);
    writeFileSync(join(base, "file"), "");
    await expect(prepare("file")).rejects.toThrow(/isn't a folder/);
  });

  it("says how to start a gateway already set up there", async () => {
    mkdirSync(join(base, "done"));
    writeFileSync(join(base, "done", "midplane.yaml"), "");
    await expect(prepare("done")).rejects.toThrow(
      `Already set up: start it with \`midplane gateway --config ${join(base, "done", "midplane.yaml")}\``,
    );
  });
});

describe("the port", () => {
  const held: Server[] = [];
  const hold = (port: number) =>
    new Promise<void>((done, fail) => {
      const s = createServer();
      s.once("error", fail);
      s.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        held.push(s);
        done();
      });
    });
  afterEach(async () => {
    await Promise.all(
      held.splice(0).map((s) => new Promise((done) => s.close(done))),
    );
  });

  it("is the first free one from 7433, so a second gateway here takes the next", async () => {
    const first = await choosePort(null);
    expect(first).toBeGreaterThanOrEqual(7433);
    expect(first).toBeLessThanOrEqual(7442);
    await hold(first);
    expect(await choosePort(null)).toBeGreaterThan(first);
  });

  it("asked for, must be free", async () => {
    const port = await choosePort(null);
    await hold(port);
    await expect(choosePort(port)).rejects.toThrow(
      `port ${port} is taken: choose another with --port`,
    );
  });
});

/** A self-signed certificate and its key, from openssl. */
function certificate(dir: string, host: string): { cert: string; key: string } {
  const keyFile = join(dir, `${host}.key`);
  const certFile = join(dir, `${host}.crt`);
  const san = /^[\d.]+$/.test(host) ? `IP:${host}` : `DNS:${host}`;
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=${san}`,
    ],
    { stdio: "pipe" },
  );
  return {
    cert: readFileSync(certFile, "utf8"),
    key: readFileSync(keyFile, "utf8"),
  };
}

describe("a server's certificate", () => {
  let dir: string;
  let gw: { cert: string; key: string };
  const now = new Date();
  const files = (pair: { cert: string; key: string }) => ({
    ...pair,
    certFile: "/tls/tls.crt",
    keyFile: "/tls/tls.key",
  });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-tls-"));
    gw = certificate(dir, "gw.example.com");
  });

  it("must cover the URL's host, by name or address", () => {
    expect(certificateProblem(files(gw), "gw.example.com", now)).toBeNull();
    expect(certificateProblem(files(gw), "other.example.com", now)).toBe(
      "the certificate in /tls/tls.crt is for DNS:gw.example.com, not other.example.com",
    );
    const ip = certificate(dir, "192.0.2.10");
    expect(certificateProblem(files(ip), "192.0.2.10", now)).toBeNull();
    expect(certificateProblem(files(ip), "192.0.2.11", now)).toMatch(
      /not 192\.0\.2\.11$/,
    );
  });

  it("must not have expired", () => {
    const later = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    expect(certificateProblem(files(gw), "gw.example.com", later)).toMatch(
      /^the certificate in \/tls\/tls\.crt expired on /,
    );
  });

  it("must match its key, and each file must be what it says", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(
      certificateProblem(files({ ...gw, key: other }), "gw.example.com", now),
    ).toBe("/tls/tls.key isn't the key of the certificate in /tls/tls.crt");
    expect(
      certificateProblem(files({ ...gw, cert: gw.key }), "gw.example.com", now),
    ).toBe("/tls/tls.crt isn't a PEM certificate");
    expect(
      certificateProblem(files({ ...gw, key: gw.cert }), "gw.example.com", now),
    ).toMatch(/^\/tls\/tls\.key isn't a PEM private key/);
  });

  it("is checked before the first question", async () => {
    const tls = join(dir, "tls");
    mkdirSync(tls);
    writeFileSync(join(tls, "tls.crt"), gw.cert);
    writeFileSync(join(tls, "tls.key"), gw.key);
    const plan = (url: string) =>
      planSetup(flags({ url, "tls-dir": tls, dir: join(dir, "gateway") }));
    await expect(
      prepareSetup(plan("https://gw.example.com")),
    ).resolves.toMatchObject({
      port: 7433,
      tls: { certFile: join(tls, "tls.crt"), keyFile: join(tls, "tls.key") },
    });
    await expect(prepareSetup(plan("https://db.example.com"))).rejects.toThrow(
      /is for DNS:gw\.example\.com, not db\.example\.com/,
    );
  });
});

describe("names and connection strings", () => {
  it("suggests an id from the database's name", () => {
    expect(suggestDatabaseId("shop")).toBe("shop");
    expect(suggestDatabaseId("Shop Prod.v2")).toBe("shop_prod_v2");
    expect(suggestDatabaseId("2024-sales")).toBe("db_2024-sales");
    expect(suggestDatabaseId("_x")).toBe("db__x");
    expect(suggestDatabaseId("Ünïcode")).toBe("db__n_code");
    expect(suggestDatabaseId("a".repeat(40))).toBe("a".repeat(32));
    expect(suggestDatabaseId(null)).toBeNull();
    expect(suggestDatabaseId("")).toBeNull();
  });

  it("reads a connection string's host and database, never its password", () => {
    expect(dsnHost("postgres://u:pw@db.example.com:5432/shop")).toBe(
      "db.example.com",
    );
    expect(dsnHost("postgres:///shop?host=/var/run/postgresql")).toBe(
      "/var/run/postgresql",
    );
    expect(dsnHost("postgres:///shop")).toBe("localhost");
    expect(dsnDatabase("postgres://u:pw@h/my%20shop")).toBe("my shop");
    expect(dsnDatabase("postgres://u:pw@h:5432")).toBeNull();
    expect(dsnDatabase("postgres://u:pw@h/")).toBeNull();
  });
});

describe("the config", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-setup-yaml-"));
    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", "mask-salt"), "s".repeat(64));
    for (const id of ["shop", "null"]) {
      writeFileSync(join(dir, "secrets", `${id}.dsn`), `postgres://h/${id}`);
    }
  });

  it("for this machine: loopback, at the gateway's .localhost name, every path beside it", () => {
    const text = setupYaml({
      cloudUrl: "https://eu.app.midplane.ai",
      name: "gw-k3m9x2qa",
      baseUrl: "http://gw-k3m9x2qa.localhost:7434",
      port: 7434,
      tls: null,
      databases: ["shop", "null"],
    });
    expect(text).toContain('  "null": { dsn: { file: secrets/null.dsn } }');
    expect(text).not.toContain("enrollment_token");
    const config = parseLinkedConfig(text, join(dir, "midplane.yaml"), {});
    expect(config.listen).toEqual({ host: "127.0.0.1", port: 7434 });
    expect(config.publicUrls).toEqual(["http://gw-k3m9x2qa.localhost:7434"]);
    expect(config.tls).toBeNull();
    expect(config.auditFile).toBe(join(dir, "audit.db"));
    expect(config.maskSalt).toBe("s".repeat(64));
    expect(config.link).toMatchObject({
      cloudUrl: "https://eu.app.midplane.ai",
      name: "gw-k3m9x2qa",
      identity: { kind: "file", path: join(dir, "identity.json") },
      bundleCache: join(dir, "bundle.jws"),
    });
    expect([...config.databases.values()]).toEqual([
      { id: "shop", dsn: "postgres://h/shop" },
      { id: "null", dsn: "postgres://h/null" },
    ]);
  });

  it("for a server: every interface, TLS from its folder, at its URL", () => {
    const text = setupYaml({
      cloudUrl: "https://eu.app.midplane.ai",
      name: "gw.example.com",
      baseUrl: "https://gw.example.com",
      port: 7433,
      tls: {
        certFile: "/etc/midplane/tls/tls.crt",
        keyFile: "/my tls/tls.key",
      },
      databases: ["shop"],
    });
    expect(parseYaml(text)).toEqual({
      listen: { host: "0.0.0.0", port: 7433 },
      public_urls: ["https://gw.example.com"],
      tls: {
        cert_file: "/etc/midplane/tls/tls.crt",
        key_file: "/my tls/tls.key",
      },
      audit: { file: "audit.db" },
      mask_salt: { file: "secrets/mask-salt" },
      link: {
        cloud_url: "https://eu.app.midplane.ai",
        name: "gw.example.com",
        identity: { file: "identity.json" },
      },
      databases: { shop: { dsn: { file: "secrets/shop.dsn" } } },
    });
  });
});
