// `midplane setup` before its first question: the flags, the folder, the
// port and the certificate, each checked before the token can be spent; the
// names it suggests; and the config it writes, which the gateway loads.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { LETS_ENCRYPT } from "../src/acme.ts";
import { certificateProblem } from "../src/certificates.ts";
import { parseLinkedConfig } from "../src/config.ts";
import { PromptClosed } from "../src/prompt.ts";
import {
  baseUrlOfSetup,
  choosePort,
  dsnDatabase,
  dsnHost,
  gatewayNameOf,
  type PreparedSetup,
  placeOf,
  planSetup,
  prepareSetup,
  SetupError,
  type SetupFlags,
  setupSummary,
  setupYaml,
  startHint,
  suggestDatabaseId,
  writeAndEnroll,
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
    ).toEqual({
      url: "https://gw.example.com",
      certificate: { kind: "files", dir: "/etc/midplane/tls" },
    });
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

  // protects=--acme plans a server whose certificate comes from Let's Encrypt, or the directory named;
  // fails_when=--acme is ignored, keeps a TLS folder, or drops --acme-directory;
  // no_claim=that the directory answers (setup finds out after the questions)
  it("take --acme for a server's own certificate, from Let's Encrypt by default", () => {
    expect(
      planSetup(flags({ url: "https://gw.example.com", acme: true })).server,
    ).toEqual({
      url: "https://gw.example.com",
      certificate: {
        kind: "acme",
        directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
      },
    });
    expect(
      planSetup(
        flags({
          url: "https://gw.example.com",
          acme: true,
          "acme-directory": "https://localhost:14000/dir",
        }),
      ).server?.certificate,
    ).toEqual({ kind: "acme", directoryUrl: "https://localhost:14000/dir" });
  });

  // protects=a wrong --acme combination fails before any question, naming the problem, so no token is spent;
  // fails_when=--acme with --tls-dir or an IP URL, or a stray --acme-directory, gets through;
  // no_claim=nothing about the dashboard, which shows Automatic only for a host name
  it("refuse --acme with --tls-dir, without --url, or for an IP address", () => {
    const url = "https://gw.example.com";
    expect(refusal({ acme: true })).toBe("--acme goes with --url");
    expect(refusal({ url, acme: true, "tls-dir": "/tls" })).toBe(
      "--acme gets the gateway a certificate, so it doesn't take --tls-dir",
    );
    for (const ip of ["https://192.0.2.10", "https://[2001:db8::1]:8443"]) {
      expect(refusal({ url: ip, acme: true }), ip).toBe(
        "--acme: an automatic certificate needs a host name, and --url names an IP address",
      );
    }
    expect(refusal({ url, "acme-directory": "https://x.example/dir" })).toBe(
      "--acme-directory goes with --acme",
    );
    expect(
      refusal({ url, acme: true, "acme-directory": "http://x.example/dir" }),
    ).toBe("--acme-directory must use https (http only on this machine)");
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

describe("--relay", () => {
  const DOMAIN = "eu.relay.test";
  /** A cloud's answer to where its relay is, and the URLs setup asked. */
  const cloudSays = (status: number, body: unknown = null) => {
    const asked: string[] = [];
    const answer = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { fetch: answer, asked };
  };
  const RELAY = { domain: DOMAIN, control: `relay.${DOMAIN}` };
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "midplane-setup-relay-"));
  });

  // protects=--relay plans a gateway at the URL the cloud's relay domain gives its slug, on loopback, with a certificate through the relay and the cloud's relay as its control name, and the config setup writes for it is one the gateway loads as relayed;
  // fails_when=the URL isn't https://<slug>.<relay domain>, the listener leaves loopback, a challenge port is bound or checked, the certificate comes from files, --acme-directory is dropped, or the written config doesn't load as the relay's;
  // no_claim=that the relay answers (the in-process tests run a stand-in relay; the cloud's, the real one)
  it("plan a gateway at the cloud's relay domain, on loopback, with its certificate through the relay", async () => {
    expect(planSetup(flags({ relay: true }), "gw-k3m9x2qa")).toMatchObject({
      server: null,
      relay: { directoryUrl: "https://acme-v02.api.letsencrypt.org/directory" },
    });
    const plan = planSetup(
      flags({
        relay: true,
        "acme-directory": "https://localhost:14000/dir",
        dir: join(base, "gw"),
        database: ["shop"],
      }),
      "gw-k3m9x2qa",
    );
    const cloud = cloudSays(200, RELAY);
    const p = await prepareSetup(plan, { place: "installed", ...cloud });
    expect(cloud.asked).toEqual(["https://eu.app.midplane.ai/link/v1/relay"]);
    expect(p).toMatchObject({
      relayed: {
        control: "relay.eu.relay.test",
        url: "https://gw-k3m9x2qa.eu.relay.test",
      },
      tls: { kind: "relayed", directoryUrl: "https://localhost:14000/dir" },
    });
    // On loopback, as on this machine: the first free port from 7433.
    expect(p.port).toBeGreaterThanOrEqual(7433);
    expect(baseUrlOfSetup(p)).toBe("https://gw-k3m9x2qa.eu.relay.test");
    expect(gatewayNameOf(p)).toBe("gw-k3m9x2qa.eu.relay.test");

    mkdirSync(join(base, "yaml", "secrets"), { recursive: true });
    writeFileSync(join(base, "yaml", "secrets", "mask-salt"), "s".repeat(64));
    writeFileSync(join(base, "yaml", "secrets", "shop.dsn"), "postgres://h/s");
    const text = setupYaml({
      cloudUrl: p.cloudUrl,
      name: gatewayNameOf(p),
      baseUrl: baseUrlOfSetup(p),
      port: p.port,
      tls: p.tls,
      relay: p.relayed?.control ?? null,
      databases: ["shop"],
    });
    expect(parseYaml(text)).toMatchObject({
      listen: { host: "127.0.0.1", port: p.port },
      relay: { control: "relay.eu.relay.test" },
      public_urls: ["https://gw-k3m9x2qa.eu.relay.test"],
      tls: { acme: { directory_url: "https://localhost:14000/dir" } },
    });
    const config = parseLinkedConfig(text, join(base, "yaml", "midplane.yaml"));
    expect(config.relay).toEqual({
      control: "relay.eu.relay.test",
      domain: DOMAIN,
    });
    expect(config.listen.host).toBe("127.0.0.1");
    expect(config.tls).toMatchObject({
      kind: "acme",
      names: ["gw-k3m9x2qa.eu.relay.test"],
      httpPort: null,
    });
    // Let's Encrypt, the default, is left out.
    expect(
      setupYaml({
        cloudUrl: p.cloudUrl,
        name: "gw-k3m9x2qa.eu.relay.test",
        baseUrl: "https://gw-k3m9x2qa.eu.relay.test",
        port: 7433,
        tls: { kind: "relayed", directoryUrl: LETS_ENCRYPT },
        relay: "relay.eu.relay.test",
        databases: ["shop"],
      }),
    ).toContain("\ntls: { acme: {} }\n");
  });

  // protects=--relay with --url, --acme or --tls-dir, and a cloud without a relay, are refused before any question, the latter naming --url instead; a cloud that can't be reached or says no relay it can use is refused too, and a stop while it answers is a stop, with nothing written;
  // fails_when=a combination gets through, a cloud without a relay is set up at a guessed domain, the refusal doesn't name --url, or the folder is written;
  // no_claim=the environment's own refusal (start.test.ts names MIDPLANE_URL)
  it("refuse --url, --acme or --tls-dir with it, and a cloud without a relay, naming --url", async () => {
    const sentence =
      "--relay doesn't take --url, --acme or --tls-dir: the gateway gets a Midplane URL, and a certificate for it through the relay";
    for (const more of [
      { url: "https://gw.example.com" },
      { url: "https://gw.example.com", acme: true },
      { "tls-dir": "/tls" },
    ]) {
      expect(refusal({ relay: true, ...more })).toBe(sentence);
    }
    expect(refusal({ relay: true, "acme-directory": "http://x.example" })).toBe(
      "--acme-directory must use https (http only on this machine)",
    );

    const dir = join(base, "refused");
    const prepare = (fetchImpl: typeof fetch) =>
      prepareSetup(planSetup(flags({ relay: true, dir }), "gw-k3m9x2qa"), {
        place: "installed",
        fetch: fetchImpl,
      });
    await expect(
      prepare(cloudSays(404, { error: "not_found" }).fetch),
    ).rejects.toThrow(
      new SetupError(
        "Midplane Cloud at https://eu.app.midplane.ai has no relay: set the gateway up at a URL of your own, with --url. Nothing was written, and the token is unused.",
      ),
    );
    for (const [status, body] of [
      [503, null],
      [200, { domain: DOMAIN, control: "relay.elsewhere.test" }],
      [200, { domain: "" }],
    ] as const) {
      await expect(prepare(cloudSays(status, body).fetch)).rejects.toThrow(
        `Midplane Cloud at https://eu.app.midplane.ai didn't say where its relay is (${status}): try again later.`,
      );
    }
    await expect(
      prepare(
        cloudSays(200, { domain: "Bad Domain", control: "relay.Bad Domain" })
          .fetch,
      ),
    ).rejects.toThrow(/named a relay domain no gateway URL can be on/);
    await expect(
      prepare((async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch),
    ).rejects.toThrow(
      "can't reach Midplane Cloud at https://eu.app.midplane.ai: fetch failed. Nothing was written, and the token is unused.",
    );
    // Stopped while the answer is still arriving: as a stop, not the cloud's fault.
    const stop = new AbortController();
    const stalled = (async (_input: unknown, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(body) {
            init?.signal?.addEventListener("abort", () =>
              body.error(new DOMException("stopped", "AbortError")),
            );
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    const stopped = prepareSetup(
      planSetup(flags({ relay: true, dir }), "gw-k3m9x2qa"),
      { place: "installed", fetch: stalled, signal: stop.signal },
    );
    setTimeout(() => stop.abort(), 20);
    await expect(stopped).rejects.toThrow(PromptClosed);
    expect(readdirSync(base)).not.toContain("refused");
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
      { place: "installed" },
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
    const plan = planSetup(flags({ dir: join(base, "done") }));
    await expect(prepareSetup(plan, { place: "npx" })).rejects.toThrow(
      `Already set up: start it with \`npx -y midplane@latest gateway --config ${join(base, "done", "midplane.yaml")}\``,
    );
    await expect(prepareSetup(plan, { place: "container" })).rejects.toThrow(
      "Already set up: start the gateway with the second command on the setup page",
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
  let ip: { cert: string; key: string };
  // Once both exist: openssl starts a certificate at the second it's made.
  let now: Date;
  const files = (pair: { cert: string; key: string }) => ({
    ...pair,
    certFile: "/tls/tls.crt",
    keyFile: "/tls/tls.key",
  });
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "midplane-tls-"));
    gw = certificate(dir, "gw.example.com");
    ip = certificate(dir, "192.0.2.10");
    now = new Date();
  });

  it("must cover the URL's host, by name or address", () => {
    expect(certificateProblem(files(gw), ["gw.example.com"], now)).toBeNull();
    expect(certificateProblem(files(gw), ["other.example.com"], now)).toBe(
      "the certificate in /tls/tls.crt is for DNS:gw.example.com, not other.example.com",
    );
    expect(certificateProblem(files(ip), ["192.0.2.10"], now)).toBeNull();
    expect(certificateProblem(files(ip), ["192.0.2.11"], now)).toMatch(
      /not 192\.0\.2\.11$/,
    );
  });

  it("must not have expired, nor be valid only later", () => {
    const later = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
    expect(certificateProblem(files(gw), ["gw.example.com"], later)).toMatch(
      /^the certificate in \/tls\/tls\.crt expired on /,
    );
    const earlier = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(certificateProblem(files(gw), ["gw.example.com"], earlier)).toMatch(
      /^the certificate in \/tls\/tls\.crt isn't valid until /,
    );
  });

  it("must match its key, and each file must be what it says", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(
      certificateProblem(files({ ...gw, key: other }), ["gw.example.com"], now),
    ).toBe("/tls/tls.key isn't the key of the certificate in /tls/tls.crt");
    expect(
      certificateProblem(
        files({ ...gw, cert: gw.key }),
        ["gw.example.com"],
        now,
      ),
    ).toBe("/tls/tls.crt isn't a PEM certificate");
    expect(
      certificateProblem(
        files({ ...gw, key: gw.cert }),
        ["gw.example.com"],
        now,
      ),
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
      tls: {
        kind: "files",
        certFile: join(tls, "tls.crt"),
        keyFile: join(tls, "tls.key"),
      },
    });
    await expect(prepareSetup(plan("https://db.example.com"))).rejects.toThrow(
      /is for DNS:gw\.example\.com, not db\.example\.com/,
    );
  });
});

describe("a server's certificate from ACME", () => {
  const held: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      held.splice(0).map((s) => new Promise((done) => s.close(done))),
    );
  });

  // protects=setup's challenge port is checked before the first question;
  // fails_when=a taken port is found only after the questions, or the TLS folder is still required;
  // no_claim=that port 80 forwards to it
  it("needs the challenge's port free, and no TLS folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "midplane-setup-acme-"));
    // Any free port but the gateway's own, 7433.
    const httpPort = await new Promise<number>((done) => {
      const s = createServer();
      s.listen(0, "0.0.0.0", () => {
        const { port } = s.address() as { port: number };
        s.close(() => done(port));
      });
    });
    const plan = planSetup(
      flags({
        url: "https://gw.example.com",
        acme: true,
        dir: join(dir, "gw"),
      }),
    );
    await expect(
      prepareSetup(plan, { acmeHttpPort: httpPort }),
    ).resolves.toMatchObject({
      port: 7433,
      tls: {
        kind: "acme",
        httpPort,
        directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
      },
    });
    await new Promise<void>((done) => {
      const s = createServer();
      s.listen({ port: httpPort, host: "0.0.0.0" }, () => {
        held.push(s);
        done();
      });
    });
    await expect(
      prepareSetup(plan, { acmeHttpPort: httpPort }),
    ).rejects.toThrow(
      `port ${httpPort} is taken: setup answers the certificate's challenge on it`,
    );
  });

  // protects=a gateway port equal to the challenge port is refused before the first question, not after the token is spent;
  // fails_when=setup accepts --port 7480 with --acme and writes a config the gateway refuses;
  // no_claim=nothing about other port conflicts on the host
  it("refuse the challenge's port as the gateway's", async () => {
    const plan = planSetup(
      flags({
        url: "https://gw.example.com",
        acme: true,
        port: "7480",
        dir: join(mkdtempSync(join(tmpdir(), "midplane-setup-acme-")), "gw"),
      }),
    );
    await expect(prepareSetup(plan)).rejects.toThrow(
      "--port 7480 is where the certificate's challenge is answered: choose another",
    );
  });

  // protects=setup never spends a token on a config the gateway would refuse to start from;
  // fails_when=a config that fails to load is enrolled, or its files stay behind;
  // no_claim=nothing about configs prepareSetup lets through (this one is built by hand to get past it)
  it("check the gateway loads the config before enrolling", async () => {
    const base = mkdtempSync(join(tmpdir(), "midplane-setup-load-"));
    const p = {
      ...planSetup(
        flags({
          url: "https://gw.example.com",
          acme: true,
          dir: join(base, "gw"),
        }),
      ),
      path: join(base, "gw"),
      port: 7480,
      tls: {
        kind: "acme" as const,
        directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
        httpPort: 7480,
      },
      relayed: null,
    };
    let fetched = false;
    await expect(
      writeAndEnroll(p, [{ id: "shop", dsn: "postgres://h/shop" }], {
        fetch: async () => {
          fetched = true;
          throw new Error("no fetch expected");
        },
      }),
    ).rejects.toThrow(
      "the gateway wouldn't start from this config (tls.acme.http_port must differ from listen.port); setup removed the files it wrote and the token is unused",
    );
    expect(fetched).toBe(false);
    expect(readdirSync(base)).toEqual([]);
  });
});

describe("how to start the gateway again", () => {
  // protects=the hint setup prints runs where setup ran: npx form under npx, the dashboard pointer in a container;
  // fails_when=a container is told a path inside itself, or an npx user a command they don't have;
  // no_claim=that the second command on the page matches this gateway's volume (the dashboard's tests)
  it("is the command for where setup ran", () => {
    expect(startHint("gw-k3m9x2qa", "installed")).toBe(
      "midplane gateway --config gw-k3m9x2qa/midplane.yaml",
    );
    expect(startHint("gw-k3m9x2qa", "npx")).toBe(
      "npx -y midplane@latest gateway --config gw-k3m9x2qa/midplane.yaml",
    );
    expect(startHint("/var/lib/midplane", "container")).toBe(
      "the second command on the setup page",
    );
  });

  // protects=where setup runs is read from /.dockerenv, then npm's npm_command=exec;
  // fails_when=a container is taken for npx, or npx for an installed command;
  // no_claim=other container runtimes without /.dockerenv (they get the installed form)
  it("knows a container, then npx, from the environment", () => {
    expect(placeOf({ inContainer: true, npx: true })).toBe("container");
    expect(placeOf({ inContainer: false, npx: true })).toBe("npx");
    expect(placeOf({ inContainer: false, npx: false })).toBe("installed");
    const was = process.env.npm_command;
    try {
      process.env.npm_command = "exec";
      expect(placeOf({ inContainer: false })).toBe("npx");
      process.env.npm_command = "run-script";
      expect(placeOf({ inContainer: false })).toBe("installed");
    } finally {
      if (was === undefined) delete process.env.npm_command;
      else process.env.npm_command = was;
    }
  });

  // protects=the summary's last lines are the hint for where setup ran;
  // fails_when=the summary still prints `midplane gateway --config` in a container or under npx;
  // no_claim=nothing about the lines above it
  it("ends setup's summary", () => {
    const p = {
      dir: "gw-k3m9x2qa",
      slug: "gw-k3m9x2qa",
      server: null,
      port: 7433,
    } as unknown as PreparedSetup;
    const enrollment = {
      projectName: "Shop",
      databasesAdded: null,
    } as unknown as Parameters<typeof setupSummary>[2];
    const tail = (place: Parameters<typeof setupSummary>[3]) =>
      setupSummary(p, [{ id: "shop", dsn: "" }], enrollment, place)
        .trimEnd()
        .split("\n")
        .slice(-2)
        .join("\n");
    expect(tail("npx")).toBe(
      "Start it again with:\n  npx -y midplane@latest gateway --config gw-k3m9x2qa/midplane.yaml",
    );
    expect(tail("container")).toMatch(
      /\nStart the gateway with the second command on the setup page\.$/,
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

  // protects=setup --acme writes `tls: { acme: {} }`, which the gateway loads as ACME for the URL's host;
  // fails_when=it writes file paths, a default it needn't, or something the config loader refuses;
  // no_claim=nothing about the certificate itself
  it("for a server with --acme: tls.acme, defaults left out", () => {
    const yaml = (tls: Parameters<typeof setupYaml>[0]["tls"]) =>
      setupYaml({
        cloudUrl: "https://eu.app.midplane.ai",
        name: "gw.example.com",
        baseUrl: "https://gw.example.com",
        port: 7433,
        tls,
        databases: ["shop"],
      });
    const text = yaml({
      kind: "acme",
      directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
      httpPort: 7480,
    });
    expect(text).toContain("\ntls: { acme: {} }\n");
    expect(parseLinkedConfig(text, join(dir, "midplane.yaml"), {}).tls).toEqual(
      {
        kind: "acme",
        names: ["gw.example.com"],
        httpPort: 7480,
        directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
        dir: join(dir, "acme"),
      },
    );
    expect(
      parseYaml(
        yaml({
          kind: "acme",
          directoryUrl: "https://localhost:14000/dir",
          httpPort: 7481,
        }),
      ).tls,
    ).toEqual({
      acme: { http_port: 7481, directory_url: "https://localhost:14000/dir" },
    });
  });

  it("for a server: every interface, TLS from its folder, at its URL", () => {
    const text = setupYaml({
      cloudUrl: "https://eu.app.midplane.ai",
      name: "gw.example.com",
      baseUrl: "https://gw.example.com",
      port: 7433,
      tls: {
        kind: "files",
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
