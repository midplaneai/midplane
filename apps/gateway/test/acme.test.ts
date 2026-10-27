// The ACME client on its own: the certificate request openssl reads, the
// challenge listener that answers one path and nothing else, and a
// certificate from the in-process stand-in directory (fake-acme.ts), with
// the sentence for each way the authority says no.

import { execFileSync } from "node:child_process";
import {
  createPublicKey,
  generateKeyPairSync,
  X509Certificate,
} from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AcmeError,
  type ChallengeListener,
  ChallengeTokens,
  certificateRequest,
  listenForChallenges,
  obtainCertificate,
} from "../src/acme.ts";
import { type FakeAcme, startFakeAcme } from "./fake-acme.ts";

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

const mode = (path: string) => statSync(path).mode & 0o777;

describe("the certificate request", () => {
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const pemOf = (der: Buffer) =>
    `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").trimEnd()}\n-----END CERTIFICATE REQUEST-----\n`;
  const openssl = (pem: string, args: string[]) => {
    const file = join(mkdtempSync(join(tmpdir(), "midplane-csr-")), "req.pem");
    writeFileSync(file, pem);
    return execFileSync("openssl", ["req", "-in", file, "-noout", ...args], {
      stdio: "pipe",
    }).toString();
  };

  // protects=the CSR Let's Encrypt receives is well-formed DER, self-signed by the certificate's key;
  // fails_when=a DER length, the signature algorithm or the signed bytes are wrong, or another key signs it;
  // no_claim=that Let's Encrypt's own parser accepts it (Pebble does, in the package smoke)
  it("is one openssl verifies, signed by the certificate's key", () => {
    const der = certificateRequest(key, ["gw.example.com"]);
    expect(() => openssl(pemOf(der), ["-verify"])).not.toThrow();
    const spki = openssl(pemOf(der), ["-pubkey"]);
    expect(createPublicKey(spki).export({ format: "jwk" })).toEqual(
      createPublicKey(key).export({ format: "jwk" }),
    );
    // One byte of the signed part changed: the signature no longer holds.
    const tampered = Buffer.from(der);
    const at = tampered.indexOf(Buffer.from("gw.example.com"));
    tampered[at] = "x".charCodeAt(0);
    expect(() => openssl(pemOf(tampered), ["-verify"])).toThrow();
  });

  // protects=every certified name is in the CSR's subjectAltName, where Let's Encrypt reads names;
  // fails_when=a name is dropped, or names go in the subject instead;
  // no_claim=that every name resolves to this server
  it("lists every name in its subjectAltName", () => {
    const text = openssl(
      pemOf(certificateRequest(key, ["gw.example.com", "db.example.com"])),
      ["-text"],
    );
    expect(text).toContain("DNS:gw.example.com, DNS:db.example.com");
    expect(text).toMatch(/Subject:\s*\n/);
  });
});

describe("the challenge listener", () => {
  let tokens: ChallengeTokens;
  let listener: ChallengeListener;
  beforeAll(async () => {
    tokens = new ChallengeTokens();
    tokens.publish("tok-1", "tok-1.thumbprint");
    listener = await listenForChallenges(0, tokens, "127.0.0.1");
  });
  afterAll(() => listener.close());

  /** A request with its path as written: fetch would resolve `..` first. */
  const request = (
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ) =>
    new Promise<{ status: number; type: string | null; body: string }>(
      (done, fail) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: listener.port,
            path,
            method: init.method ?? "GET",
            headers: init.headers ?? {},
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (d) => {
              body += d;
            });
            res.on("end", () =>
              done({
                status: res.statusCode ?? 0,
                type: res.headers["content-type"] ?? null,
                body,
              }),
            );
          },
        );
        req.on("error", fail);
        req.end(init.body);
      },
    );

  // protects=the authority gets the key authorization for a token pending now;
  // fails_when=a pending token is answered with anything but 200 and its key authorization;
  // no_claim=that port 80 on the server reaches this listener
  it("answers a GET for a pending token with its key authorization", async () => {
    expect(await request("/.well-known/acme-challenge/tok-1")).toEqual({
      status: 200,
      type: "text/plain",
      body: "tok-1.thumbprint",
    });
  });

  // protects=nothing but a pending token is served;
  // fails_when=an unknown, withdrawn or malformed token returns anything but an empty 404;
  // no_claim=how long the authority keeps a token pending
  it("answers 404 with nothing for an unknown or withdrawn token", async () => {
    tokens.publish("tok-2", "tok-2.thumbprint");
    tokens.withdraw("tok-2");
    for (const path of [
      "/.well-known/acme-challenge/tok-2",
      "/.well-known/acme-challenge/unknown",
      "/.well-known/acme-challenge/tok-1?x=1",
      "/.well-known/acme-challenge/../acme-challenge/tok-1",
      "/.well-known/acme-challenge/",
    ]) {
      expect(await request(path), path).toEqual({
        status: 404,
        type: null,
        body: "",
      });
    }
  });

  // protects=the TLS rule: no MCP request or agent token is ever handled in the clear;
  // fails_when=/mcp or any other path answers with anything but an empty 404, whatever the Authorization header;
  // no_claim=what a client sends before it learns the listener is the wrong place
  it("answers /mcp and everything else 404 with nothing, token or not", async () => {
    const auth = { authorization: "Bearer mp.agent.token" };
    for (const [path, init] of [
      ["/mcp", {}],
      ["/mcp", { method: "POST", headers: auth, body: "{}" }],
      ["/", { headers: auth }],
      ["/healthz", {}],
      ["/.well-known/oauth-protected-resource/mcp", {}],
    ] as const) {
      expect(await request(path, init), path).toEqual({
        status: 404,
        type: null,
        body: "",
      });
    }
  });

  // protects=only GET reads a token;
  // fails_when=HEAD, POST or PUT of a pending token's path answers;
  // no_claim=nothing about methods the authority itself uses beyond GET
  it("answers only GET", async () => {
    for (const method of ["HEAD", "POST", "PUT", "DELETE"]) {
      expect(
        (await request("/.well-known/acme-challenge/tok-1", { method })).status,
        method,
      ).toBe(404);
    }
  });
});

describe("a certificate from the authority", () => {
  let acme: FakeAcme;
  let tokens: ChallengeTokens;
  let listener: ChallengeListener;
  beforeAll(async () => {
    acme = await startFakeAcme();
    tokens = new ChallengeTokens();
    listener = await listenForChallenges(0, tokens, "127.0.0.1");
  });
  afterEach(() => {
    acme.failValidation = null;
    acme.challengePort = listener.port;
  });
  afterAll(async () => {
    await listener.close();
    await acme.close();
  });

  const obtain = (dir: string, names = ["gw.test"]) =>
    obtainCertificate({
      directoryUrl: acme.url,
      names,
      dir,
      challenges: tokens,
      httpPort: 7480,
      polling: POLLING,
    });

  // protects=an issued certificate and its key are kept, closed to others, and the challenge answered over the listener;
  // fails_when=the chain, key or account key isn't written, is readable by others, or a refused nonce isn't retried;
  // no_claim=Let's Encrypt's own behavior: the stand-in directory, and Pebble in the package smoke
  it("answers the challenge, and keeps the certificate, its key and the account key", async () => {
    acme.challengePort = listener.port;
    acme.rejectNextNonce = true;
    const dir = join(mkdtempSync(join(tmpdir(), "midplane-acme-")), "acme");
    const issued = await obtain(dir);

    expect(acme.badNonces).toBe(1);
    // RFC 8555 (6.1): the client names itself.
    expect(acme.userAgent).toMatch(/^midplane\/\d+\.\d+\.\d+/);
    expect(acme.fetches.at(-1)).toMatchObject({ status: 200 });
    const leaf = new X509Certificate(issued.cert);
    expect(leaf.checkHost("gw.test")).toBe("gw.test");
    expect(leaf.verify(new X509Certificate(acme.ca).publicKey)).toBe(true);
    expect(readFileSync(join(dir, "cert.pem"), "utf8")).toBe(issued.cert);
    expect(readFileSync(join(dir, "key.pem"), "utf8")).toBe(issued.key);
    expect(readdirSync(dir).sort()).toEqual([
      "account.key",
      "cert.pem",
      "key.pem",
    ]);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, "account.key"))).toBe(0o600);
    expect(mode(join(dir, "key.pem"))).toBe(0o600);

    // Again: the same account, a new key, nothing left pending.
    const account = readFileSync(join(dir, "account.key"), "utf8");
    const again = await obtain(dir);
    expect(readFileSync(join(dir, "account.key"), "utf8")).toBe(account);
    expect(again.key).not.toBe(issued.key);
    const token = acme.fetches.at(-1)?.path.split("/").at(-1) as string;
    expect(tokens.answer("GET", `/.well-known/acme-challenge/${token}`)).toBe(
      null,
    );
  });

  // protects=each failure the authority reports reads as what to fix where the gateway runs;
  // fails_when=a DNS, port 80, rate-limit or CAA problem gets another sentence, or loses the authority's type and detail;
  // no_claim=that the real Let's Encrypt reports these causes with these types (its documentation says so)
  it("says what to fix for each problem, and keeps what the authority said", async () => {
    const ca = `the ACME server at ${new URL(acme.url).host}`;
    const cases: [string, string][] = [
      ["dns", "the DNS for gw.test doesn't point at this server"],
      ["unauthorized", "the DNS for gw.test doesn't point at this server"],
      [
        "connection",
        "port 80 on gw.test isn't reachable from the internet: open it, forwarded to port 7480 here",
      ],
      [
        "rateLimited",
        `${ca} is rate limiting certificates for gw.test: try again later`,
      ],
      ["caa", `the CAA records for gw.test forbid ${ca}`],
      ["serverInternal", `${ca} refused a certificate for gw.test`],
    ];
    for (const [kind, sentence] of cases) {
      const problem = {
        type: `urn:ietf:params:acme:error:${kind}`,
        detail: `${kind} detail`,
      };
      acme.failValidation = problem;
      const dir = join(mkdtempSync(join(tmpdir(), "midplane-acme-")), "acme");
      const err = await obtain(dir).catch((e: unknown) => e);
      expect(err, kind).toBeInstanceOf(AcmeError);
      expect((err as AcmeError).message, kind).toBe(sentence);
      expect((err as AcmeError).problem, kind).toEqual(problem);
      expect((err as AcmeError).kind, kind).toBe(kind);
      // No certificate is kept from a failed order.
      expect(readdirSync(dir), kind).toEqual(["account.key"]);
    }
  });

  // protects=a real failed fetch (nothing on port 80) becomes the port-80 sentence;
  // fails_when=the authority's connection problem is reported as anything else;
  // no_claim=how Let's Encrypt words its detail
  it("names port 80 when the authority can't connect", async () => {
    acme.challengePort = await freePort();
    const err = (await obtain(
      join(mkdtempSync(join(tmpdir(), "midplane-acme-")), "acme"),
    ).catch((e: unknown) => e)) as AcmeError;
    expect(err.message).toBe(
      "port 80 on gw.test isn't reachable from the internet: open it, forwarded to port 7480 here",
    );
    expect(err.problem?.type).toBe("urn:ietf:params:acme:error:connection");
  });
});
