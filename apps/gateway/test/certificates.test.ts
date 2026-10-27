// The certificate a TLS listener serves, kept current without a restart:
// when an ACME certificate is due for renewal, and a file certificate
// replaced on disk, checked against a real HTTPS server here, which new
// connections see and open ones don't.

import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type TLSSocket } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Certificates,
  FILE_CHECK_MS,
  needsCertificate,
  startCertificates,
} from "../src/certificates.ts";
import type { TlsConfig } from "../src/config.ts";
import { type FakeAcme, startFakeAcme, testCertificate } from "./fake-acme.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
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

const fingerprint = (pem: string) =>
  createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");

/** A TLS connection to the server, as a client for `gw.test` makes one. */
function open(port: number): Promise<TLSSocket> {
  return new Promise((done, fail) => {
    const socket = connect(
      {
        host: "127.0.0.1",
        port,
        servername: "gw.test",
        rejectUnauthorized: false,
      },
      () => done(socket),
    );
    socket.once("error", fail);
  });
}

/** The certificate a new connection is served. */
async function served(port: number): Promise<string> {
  const socket = await open(port);
  const raw = socket.getPeerCertificate().raw;
  socket.destroy();
  return createHash("sha256").update(raw).digest("hex");
}

/** One HTTP request on an open connection, and its answer. */
function ask(socket: TLSSocket): Promise<string> {
  return new Promise((done) => {
    socket.once("data", (d) => done(String(d)));
    socket.write("GET / HTTP/1.1\r\nHost: gw.test\r\n\r\n");
  });
}

/** An HTTPS server that serves what `certificates` hold, on a free port. */
async function serve(certificates: Certificates): Promise<{
  server: Server;
  port: number;
}> {
  const server = createHttpsServer(
    { key: certificates.current.key, cert: certificates.current.cert },
    (_, res) => res.end("ok"),
  );
  certificates.attach(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, port: (server.address() as { port: number }).port };
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanup.splice(0).reverse()) await c();
});

function logs() {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: (f: Record<string, unknown>) => void lines.push(f) };
}

describe("when an ACME certificate is replaced", () => {
  const now = new Date("2026-10-26T12:00:00Z");
  const at = (days: number) => new Date(now.getTime() + days * DAY_MS);
  const stored = (days: number, names = ["gw.test"]) =>
    testCertificate({ names, notBefore: at(-60), notAfter: at(days) });

  // protects=a certificate with more than 30 days left is kept, so a restart sends no order;
  // fails_when=one with 31 days left is renewed;
  // no_claim=nothing about the clock's accuracy on the server
  it("keeps one with 31 days left", () => {
    expect(needsCertificate(stored(31), ["gw.test"], now)).toBe(false);
  });

  // protects=renewal starts with 30 days left, Let's Encrypt's own advice;
  // fails_when=one with exactly 30 days left is kept;
  // no_claim=that the renewal then succeeds
  it("renews one with 30 days left", () => {
    expect(needsCertificate(stored(30), ["gw.test"], now)).toBe(true);
  });

  // protects=an expired certificate, or none, or one whose key file doesn't match, is never served on;
  // fails_when=any of them is kept;
  // no_claim=nothing about certificates revoked before they expire
  it("replaces one expired, missing or without its own key", () => {
    expect(needsCertificate(stored(0), ["gw.test"], now)).toBe(true);
    expect(needsCertificate(stored(-1), ["gw.test"], now)).toBe(true);
    expect(needsCertificate(null, ["gw.test"], now)).toBe(true);
    const other = stored(60);
    expect(
      needsCertificate({ ...stored(60), key: other.key }, ["gw.test"], now),
    ).toBe(true);
    expect(
      needsCertificate({ cert: "not pem", key: other.key }, ["gw.test"], now),
    ).toBe(true);
  });

  // protects=a changed public URL gets a certificate for its host at the next start;
  // fails_when=a certificate missing a configured name is kept;
  // no_claim=that the new name resolves to this server
  it("replaces one that doesn't cover every name", () => {
    expect(needsCertificate(stored(60), ["other.test"], now)).toBe(true);
    expect(needsCertificate(stored(60), ["gw.test", "db.test"], now)).toBe(
      true,
    );
    expect(
      needsCertificate(stored(60, ["gw.test", "db.test"]), ["db.test"], now),
    ).toBe(false);
  });
});

describe("a certificate from ACME", () => {
  let acme: FakeAcme;
  const start = async () => {
    acme ??= await startFakeAcme();
    const httpPort = await freePort();
    acme.challengePort = httpPort;
    const dir = mkdtempSync(join(tmpdir(), "midplane-certs-"));
    const tls: TlsConfig = {
      kind: "acme",
      names: ["gw.test"],
      httpPort,
      directoryUrl: acme.url,
      dir: join(dir, "acme"),
    };
    return { tls, dir };
  };
  afterEach(() => {
    if (acme) {
      acme.failValidation = null;
      acme.validDays = 90;
    }
  });

  // protects=the certificate is obtained once and reused: a restart with more than 30 days left sends no order;
  // fails_when=a restart orders again, or serves another certificate;
  // no_claim=Let's Encrypt's rate limits themselves (the stand-in counts orders)
  it("is obtained at the first start, kept, and reused after a restart", async () => {
    const { tls } = await start();
    const before = acme.newOrders;
    const { lines, log } = logs();
    const first = await startCertificates(tls, ["https://gw.test"], log, {
      timing: { polling: POLLING },
    });
    await first.close();
    expect(acme.newOrders).toBe(before + 1);
    expect(lines).toMatchObject([
      { level: "info", msg: "certificate obtained", names: ["gw.test"] },
    ]);

    const again = await startCertificates(tls, ["https://gw.test"], log, {
      timing: { polling: POLLING },
    });
    cleanup.push(() => again.close());
    expect(acme.newOrders).toBe(before + 1);
    expect(fingerprint(again.current.cert)).toBe(
      fingerprint(first.current.cert),
    );
    expect(lines).toHaveLength(1);
  });

  // protects=inside its last 30 days the check renews it, and new TLS connections get the new one without a restart;
  // fails_when=the old certificate is still served to new connections, or the open connection drops;
  // no_claim=the gateway's MCP session over it (acme.e2e.test.ts), or Let's Encrypt (Pebble in the package smoke)
  it("is renewed in its last 30 days and served to new connections, while open ones go on", async () => {
    const { tls } = await start();
    acme.validDays = 20;
    const { lines, log } = logs();
    const certificates = await startCertificates(
      tls,
      ["https://gw.test"],
      log,
      {
        timing: { polling: POLLING },
      },
    );
    cleanup.push(() => certificates.close());
    const { server, port } = await serve(certificates);
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
    const old = fingerprint(certificates.current.cert);
    expect(await served(port)).toBe(old);
    const kept = await open(port);
    cleanup.push(() => void kept.destroy());
    expect(await ask(kept)).toContain("200 OK");

    const orders = acme.newOrders;
    acme.validDays = 90;
    await certificates.check();
    expect(acme.newOrders).toBe(orders + 1);
    const renewed = fingerprint(certificates.current.cert);
    expect(renewed).not.toBe(old);
    expect(await served(port)).toBe(renewed);
    expect(lines.at(-1)).toMatchObject({
      level: "info",
      msg: "certificate renewed",
    });
    // The connection opened before goes on, with the certificate it began with.
    expect(await ask(kept)).toContain("200 OK");
    expect(
      createHash("sha256").update(kept.getPeerCertificate().raw).digest("hex"),
    ).toBe(old);

    // Not due again: the next check orders nothing.
    await certificates.check();
    expect(acme.newOrders).toBe(orders + 1);
  });

  // protects=a failed renewal leaves the current certificate served and says why in a warning;
  // fails_when=the gateway stops serving, swaps in nothing valid, or logs nothing;
  // no_claim=that the next check succeeds (it retries at the next check)
  it("keeps serving the current one when a renewal fails, and warns", async () => {
    const { tls } = await start();
    acme.validDays = 20;
    const { lines, log } = logs();
    const certificates = await startCertificates(
      tls,
      ["https://gw.test"],
      log,
      {
        timing: { polling: POLLING },
      },
    );
    cleanup.push(() => certificates.close());
    const { server, port } = await serve(certificates);
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
    const old = fingerprint(certificates.current.cert);

    acme.failValidation = {
      type: "urn:ietf:params:acme:error:dns",
      detail: "NXDOMAIN looking up A for gw.test",
    };
    await certificates.check();
    expect(fingerprint(certificates.current.cert)).toBe(old);
    expect(await served(port)).toBe(old);
    expect(lines.at(-1)).toEqual({
      level: "warn",
      msg: "certificate renewal failed",
      error: "the DNS for gw.test doesn't point at this server",
      acme_type: "urn:ietf:params:acme:error:dns",
      acme_detail: "NXDOMAIN looking up A for gw.test",
    });
  });

  // protects=a restart inside the last 30 days, while the authority refuses, still serves the stored certificate and renews later;
  // fails_when=the gateway refuses to start while it holds a certificate still in date, or starts with an expired one;
  // no_claim=that the authority recovers before the stored certificate expires
  it("restarts on a stored one still in date when renewing fails, and warns", async () => {
    const { tls } = await start();
    acme.validDays = 20;
    const first = await startCertificates(tls, ["https://gw.test"], () => {}, {
      timing: { polling: POLLING },
    });
    await first.close();

    acme.failValidation = {
      type: "urn:ietf:params:acme:error:connection",
      detail: "Timeout during connect",
    };
    const { lines, log } = logs();
    const again = await startCertificates(tls, ["https://gw.test"], log, {
      timing: { polling: POLLING },
    });
    cleanup.push(() => again.close());
    expect(fingerprint(again.current.cert)).toBe(
      fingerprint(first.current.cert),
    );
    expect(lines).toMatchObject([
      {
        level: "warn",
        msg: "certificate renewal failed",
        acme_type: "urn:ietf:params:acme:error:connection",
        valid_until: new X509Certificate(
          first.current.cert,
        ).validToDate.toISOString(),
      },
    ]);
    await again.close();

    // Once it has expired, nothing is left to serve: the start fails.
    await expect(
      startCertificates(tls, ["https://gw.test"], () => {}, {
        now: () => new Date(Date.now() + 25 * DAY_MS),
        timing: { polling: POLLING },
      }),
    ).rejects.toMatchObject({
      problem: { type: "urn:ietf:params:acme:error:connection" },
    });
  });

  // protects=without a certificate the listener can't start: the first start fails with the authority's problem, and frees its port;
  // fails_when=it starts anyway, or the error loses the problem's type and detail;
  // no_claim=nothing about how the CLI prints it (cli.ts logs these fields)
  it("fails the first start with the problem, and frees the challenge port", async () => {
    const { tls } = await start();
    acme.failValidation = {
      type: "urn:ietf:params:acme:error:connection",
      detail: "Timeout during connect (likely firewall problem)",
    };
    await expect(
      startCertificates(tls, ["https://gw.test"], () => {}, {
        timing: { polling: POLLING },
      }),
    ).rejects.toMatchObject({
      message: `port 80 on gw.test isn't reachable from the internet: open it, forwarded to port ${tls.kind === "acme" ? (tls.httpPort ?? 0) : 0} here`,
      problem: {
        type: "urn:ietf:params:acme:error:connection",
        detail: "Timeout during connect (likely firewall problem)",
      },
    });
    const port = tls.kind === "acme" ? (tls.httpPort ?? 0) : 0;
    await new Promise<void>((done, fail) => {
      const s = createServer();
      s.once("error", fail);
      s.listen(port, "0.0.0.0", () => s.close(() => done()));
    });
  });
});

describe("a certificate from files", () => {
  const files = (pair: { cert: string; key: string }) => {
    const dir = mkdtempSync(join(tmpdir(), "midplane-files-"));
    const certFile = join(dir, "tls.crt");
    const keyFile = join(dir, "tls.key");
    writeFileSync(certFile, pair.cert);
    writeFileSync(keyFile, pair.key);
    const tls: TlsConfig = { kind: "files", certFile, keyFile, ...pair };
    return {
      tls,
      replace: (next: { cert: string; key: string }) => {
        writeFileSync(certFile, next.cert);
        writeFileSync(keyFile, next.key);
      },
    };
  };

  // protects=a certificate renewed on disk is served within 10 minutes, without a restart;
  // fails_when=the timer is longer than 10 minutes, or new connections still get the old one;
  // no_claim=how the file got there (certbot, a secret manager)
  it("serves one replaced on disk within 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = testCertificate({ names: ["gw.test"] });
    const { tls, replace } = files(first);
    const { lines, log } = logs();
    const certificates = await startCertificates(
      tls,
      ["https://gw.test:8443"],
      log,
    );
    cleanup.push(() => certificates.close());
    const { server, port } = await serve(certificates);
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
    expect(await served(port)).toBe(fingerprint(first.cert));

    const next = testCertificate({ names: ["gw.test", "db.test"] });
    replace(next);
    await vi.advanceTimersByTimeAsync(FILE_CHECK_MS - 1);
    expect(await served(port)).toBe(fingerprint(first.cert));
    await vi.advanceTimersByTimeAsync(1);
    expect(await served(port)).toBe(fingerprint(next.cert));
    expect(lines).toMatchObject([
      {
        level: "info",
        msg: "certificate reloaded",
        file: tls.kind === "files" ? tls.certFile : "",
      },
    ]);
  });

  // protects=an unchanged file is left alone;
  // fails_when=a check swaps or logs anything when nothing changed;
  // no_claim=nothing about files changed and changed back between checks
  it("leaves the certificate alone when the files haven't changed", async () => {
    const first = testCertificate({ names: ["gw.test"] });
    const { tls } = files(first);
    const { lines, log } = logs();
    const certificates = await startCertificates(tls, ["https://gw.test"], log);
    cleanup.push(() => certificates.close());
    let swaps = 0;
    certificates.attach({ setSecureContext: () => void swaps++ });
    await certificates.check();
    await certificates.check();
    expect(swaps).toBe(0);
    expect(lines).toEqual([]);
  });

  // protects=a replacement not valid yet is served once it becomes valid, having warned once;
  // fails_when=a refused replacement is never checked again, or the warning repeats each check;
  // no_claim=nothing about the server's clock being right
  it("serves a replacement once it becomes valid", async () => {
    let clock = Date.now();
    const first = testCertificate({ names: ["gw.test"] });
    const { tls, replace } = files(first);
    const { lines, log } = logs();
    const certificates = await startCertificates(
      tls,
      ["https://gw.test"],
      log,
      { now: () => new Date(clock) },
    );
    cleanup.push(() => certificates.close());
    const later = testCertificate({
      names: ["gw.test"],
      notBefore: new Date(clock + 60 * 60 * 1000),
    });
    replace(later);
    await certificates.check();
    await certificates.check();
    expect(fingerprint(certificates.current.cert)).toBe(
      fingerprint(first.cert),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "warn",
      msg: "certificate not reloaded",
      error: expect.stringContaining("isn't valid until"),
    });

    clock += 2 * 60 * 60 * 1000;
    await certificates.check();
    expect(fingerprint(certificates.current.cert)).toBe(
      fingerprint(later.cert),
    );
    expect(lines.at(-1)).toMatchObject({ msg: "certificate reloaded" });
  });

  // protects=a broken replacement never replaces a working certificate, and says why, once;
  // fails_when=a mismatched key, another host's or an expired certificate is served, or the warning repeats every check;
  // no_claim=nothing about a key and certificate written at different moments (the next check after both takes them)
  it("keeps the old one when the replacement is wrong, and warns once", async () => {
    const first = testCertificate({ names: ["gw.test"] });
    const { tls, replace } = files(first);
    const { lines, log } = logs();
    const certificates = await startCertificates(
      tls,
      ["https://gw.test", "https://tunnel.example.net"],
      log,
    );
    cleanup.push(() => certificates.close());
    const { server, port } = await serve(certificates);
    cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
    const certFile = tls.kind === "files" ? tls.certFile : "";
    const keyFile = tls.kind === "files" ? tls.keyFile : "";

    const other = testCertificate({ names: ["gw.test"] });
    replace({
      cert: testCertificate({ names: ["gw.test"] }).cert,
      key: other.key,
    });
    await certificates.check();
    await certificates.check();
    replace(testCertificate({ names: ["db.test"] }));
    await certificates.check();
    replace(
      testCertificate({
        names: ["gw.test"],
        notBefore: new Date(Date.now() - 3 * DAY_MS),
        notAfter: new Date(Date.now() - DAY_MS),
      }),
    );
    await certificates.check();

    expect(await served(port)).toBe(fingerprint(first.cert));
    expect(lines.map((l) => [l.level, l.msg, l.error])).toEqual([
      [
        "warn",
        "certificate not reloaded",
        `${keyFile} isn't the key of the certificate in ${certFile}`,
      ],
      [
        "warn",
        "certificate not reloaded",
        `the certificate in ${certFile} is for DNS:db.test, not gw.test`,
      ],
      [
        "warn",
        "certificate not reloaded",
        expect.stringMatching(
          new RegExp(`^the certificate in ${certFile} expired on `),
        ),
      ],
    ]);

    // A good one, at last, for the gateway's host though not the tunnel's.
    const good = testCertificate({ names: ["gw.test"] });
    replace(good);
    await certificates.check();
    expect(await served(port)).toBe(fingerprint(good.cert));
  });
});
