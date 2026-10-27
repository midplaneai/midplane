// A server gateway's own certificate, from an ACME certificate authority
// (RFC 8555), Let's Encrypt by default. HTTP-01 only: the authority fetches
// a token from port 80 of the certified name, which the server forwards to
// a plain-HTTP challenge listener here. No ACME library: requests are JWS
// signed with `jose`, and the certificate request is a few lines of DER.
//
// The challenge listener answers one thing, a GET for a token pending right
// now, and 404 with an empty body to everything else. It never reads an
// Authorization header and never reaches the MCP handler, so no token ever
// crosses it in the clear: TLS off loopback still guards everything else.
// A gateway reached through the relay binds no port for it: the relay hands
// it each challenge request on a work connection (relay.ts).
//
// The account key, the certificate and its key live in one folder (the
// config's `acme/`), each file written whole or not at all.

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  X509Certificate,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import {
  calculateJwkThumbprint,
  exportJWK,
  FlattenedSign,
  type JWK,
} from "jose";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION } from "./tools.ts";

export const LETS_ENCRYPT = "https://acme-v02.api.letsencrypt.org/directory";
/** Where the challenge listener binds by default; the server forwards port 80 to it. */
export const ACME_HTTP_PORT = 7480;
export const CHALLENGE_PATH = "/.well-known/acme-challenge/";
/** Who is asking, as RFC 8555 (6.1) asks every ACME client to say. */
const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

/** The files in the ACME folder: setup removes them if it fails. */
export const ACME_FILES = {
  account: "account.key",
  key: "key.pem",
  cert: "cert.pem",
} as const;

// ── DER, as much as a certificate request needs ────────────────────────────

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One DER value: its tag, its length, then its contents. */
export function tlv(tag: number, ...contents: Uint8Array[]): Buffer {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

export const der = {
  sequence: (...c: Uint8Array[]) => tlv(0x30, ...c),
  set: (...c: Uint8Array[]) => tlv(0x31, ...c),
  oid,
  octetString: (b: Uint8Array) => tlv(0x04, b),
  /** A bit string of whole bytes. */
  bitString: (b: Uint8Array) => tlv(0x03, Buffer.from([0]), b),
  utf8String: (s: string) => tlv(0x0c, Buffer.from(s, "utf8")),
  /** A subjectAltName's dNSName: [2] IMPLICIT IA5String. */
  dnsName: (name: string) => tlv(0x82, Buffer.from(name, "ascii")),
  OID: {
    commonName: "2.5.4.3",
    subjectAltName: "2.5.29.17",
    basicConstraints: "2.5.29.19",
    extensionRequest: "1.2.840.113549.1.9.14",
    ecdsaWithSha256: "1.2.840.10045.4.3.2",
  },
};

/**
 * A PKCS #10 certificate request (DER) for `names`, with `key`'s public half,
 * signed by it. The names are the subjectAltName, as Let's Encrypt reads
 * them; the subject is left empty, so no name is too long for it.
 */
export function certificateRequest(
  key: KeyObject,
  names: readonly string[],
): Buffer {
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const altNames = der.sequence(...names.map(der.dnsName));
  const info = der.sequence(
    tlv(0x02, Buffer.from([0])), // version 1
    der.sequence(), // subject
    spki,
    tlv(
      0xa0, // [0] attributes
      der.sequence(
        der.oid(der.OID.extensionRequest),
        der.set(
          der.sequence(
            der.sequence(
              der.oid(der.OID.subjectAltName),
              der.octetString(altNames),
            ),
          ),
        ),
      ),
    ),
  );
  const signature = sign("sha256", info, { key, dsaEncoding: "der" });
  return der.sequence(
    info,
    der.sequence(der.oid(der.OID.ecdsaWithSha256)),
    der.bitString(signature),
  );
}

// ── problems, as sentences ─────────────────────────────────────────────────

export interface AcmeProblem {
  type: string;
  detail: string;
}

const ProblemSchema = z.object({
  type: z.string().default("about:blank"),
  detail: z.string().default(""),
});

/** Why there is no certificate: a sentence, and the authority's problem if it sent one. */
export class AcmeError extends Error {
  readonly problem: AcmeProblem | null;

  constructor(message: string, problem: AcmeProblem | null = null) {
    super(message);
    this.name = "AcmeError";
    this.problem = problem;
  }

  /** The problem's type without RFC 8555's prefix, e.g. `connection`. */
  get kind(): string | null {
    return (
      this.problem?.type.replace(/^urn:ietf:params:acme:error:/, "") ?? null
    );
  }
}

/** How messages name the authority: Let's Encrypt, or the directory's host. */
export function authorityName(directoryUrl: string): string {
  const host = new URL(directoryUrl).host;
  return /(^|\.)letsencrypt\.org$/.test(host)
    ? "Let's Encrypt"
    : `the ACME server at ${host}`;
}

interface Context {
  ca: string;
  /** The names asked for, the first named in sentences. */
  host: string;
  /** The challenge listener's port; null when challenges come through the relay. */
  httpPort: number | null;
}

/**
 * The sentence for a problem. A challenge's problems say what is wrong
 * where the gateway runs: its DNS, or port 80; the rest name the authority.
 */
function failure(
  problem: AcmeProblem,
  c: Context,
  fromChallenge: boolean,
): AcmeError {
  const kind = problem.type.replace(/^urn:ietf:params:acme:error:/, "");
  let sentence = `${c.ca} refused a certificate for ${c.host}`;
  if (fromChallenge && c.httpPort === null) {
    // The relay's DNS and port 80 are Midplane's: what is wrong is the way
    // through it, to this gateway's work connections.
    sentence = `${c.ca} couldn't fetch the challenge for ${c.host} through the relay (${kind})`;
  } else if (
    fromChallenge &&
    (kind === "dns" || kind === "unauthorized" || kind === "incorrectResponse")
  ) {
    sentence = `the DNS for ${c.host} doesn't point at this server`;
  } else if (fromChallenge && kind === "connection") {
    const forward =
      c.httpPort === 80 ? "" : `, forwarded to port ${c.httpPort} here`;
    sentence = `port 80 on ${c.host} isn't reachable from the internet: open it${forward}`;
  } else if (kind === "rateLimited") {
    sentence = `${c.ca} is rate limiting certificates for ${c.host}: try again later`;
  } else if (kind === "caa") {
    sentence = `the CAA records for ${c.host} forbid ${c.ca}`;
  }
  return new AcmeError(sentence, problem);
}

// ── the challenge listener ─────────────────────────────────────────────────

const TOKEN = /^[A-Za-z0-9_-]+$/;

/** The key authorizations pending now, by token. */
export class ChallengeTokens {
  private readonly pending = new Map<string, string>();

  publish(token: string, keyAuthorization: string): void {
    this.pending.set(token, keyAuthorization);
  }

  withdraw(token: string): void {
    this.pending.delete(token);
  }

  /**
   * The body for a request, or null for 404: only a GET of
   * `/.well-known/acme-challenge/<token>` for a token pending now.
   */
  answer(method: string | undefined, path: string | undefined): string | null {
    if (method !== "GET" || !path?.startsWith(CHALLENGE_PATH)) return null;
    const token = path.slice(CHALLENGE_PATH.length);
    if (!TOKEN.test(token)) return null;
    return this.pending.get(token) ?? null;
  }
}

export interface ChallengeListener {
  port: number;
  close(): Promise<void>;
}

/** The answer to one request: the method and path read, never a header or a body. */
function answerChallenge(
  tokens: ChallengeTokens,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const body = tokens.answer(req.method, req.url);
  if (body === null) {
    res.writeHead(404, { "content-length": "0" });
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": "text/plain",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** The challenge handler with no port bound, for connections handed to it. */
export interface ChallengeHandler {
  /**
   * Serve one connection: plain HTTP, paused, with any bytes already read
   * given back to it (`unshift`).
   */
  serve(socket: Duplex): void;
  /** Close every connection it serves now. */
  close(): void;
}

/**
 * Answer challenges on connections something else accepted: the relay's
 * port 80, carried on a work connection. Nothing listens.
 */
export function challengeHandler(tokens: ChallengeTokens): ChallengeHandler {
  const server: Server = createServer((req, res) =>
    answerChallenge(tokens, req, res),
  );
  const open = new Set<Duplex>();
  return {
    serve(socket) {
      open.add(socket);
      socket.once("close", () => open.delete(socket));
      server.emit("connection", socket);
      // Its reader is attached now; a paused socket wouldn't flow to it,
      // and the bytes given back would wait there unread.
      socket.resume();
    },
    close() {
      for (const socket of open) socket.destroy();
    },
  };
}

/**
 * Plain HTTP on every interface, for the authority's fetch. It reads the
 * method and path, never a header or a body.
 */
export function listenForChallenges(
  port: number,
  tokens: ChallengeTokens,
  host = "0.0.0.0",
): Promise<ChallengeListener> {
  const server: Server = createServer((req, res) =>
    answerChallenge(tokens, req, res),
  );
  return new Promise((done, fail) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      const why =
        err.code === "EADDRINUSE"
          ? `port ${port} is taken`
          : `can't listen on port ${port} (${err.code ?? err.message})`;
      fail(
        new AcmeError(
          `${why}: the certificate's challenge listener needs it (tls.acme.http_port)`,
        ),
      );
    });
    server.listen({ port, host }, () => {
      const bound = server.address();
      done({
        port: typeof bound === "object" && bound ? bound.port : port,
        close: () =>
          new Promise<void>((closed) => {
            server.close(() => closed());
            server.closeAllConnections();
          }),
      });
    });
  });
}

// ── what is kept ───────────────────────────────────────────────────────────

/** A certificate chain (PEM, the certificate first) and its key. */
export interface StoredCertificate {
  cert: string;
  key: string;
}

/** The certificate and key in `dir`, or null if either is missing. */
export function readStoredCertificate(dir: string): StoredCertificate | null {
  try {
    return {
      cert: readFileSync(join(dir, ACME_FILES.cert), "utf8"),
      key: readFileSync(join(dir, ACME_FILES.key), "utf8"),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Written whole or not at all: a temporary file, renamed over the old one. */
function writeWhole(path: string, text: string, mode: number): void {
  const temporary = `${path}.tmp`;
  try {
    unlinkSync(temporary);
  } catch {}
  writeFileSync(temporary, text, { mode, flag: "wx" });
  try {
    renameSync(temporary, path);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw err;
  }
}

/**
 * Keep a new certificate: the key first, so a crash between the two leaves
 * a key that doesn't match the old certificate, which is then replaced.
 */
function storeCertificate(dir: string, c: StoredCertificate): void {
  writeWhole(join(dir, ACME_FILES.key), c.key, 0o600);
  writeWhole(join(dir, ACME_FILES.cert), c.cert, 0o644);
}

function accountKey(dir: string): KeyObject {
  const path = join(dir, ACME_FILES.account);
  try {
    return createPrivateKey(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  writeWhole(
    path,
    privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    0o600,
  );
  return privateKey;
}

// ── the protocol ───────────────────────────────────────────────────────────

const DirectorySchema = z.object({
  newNonce: z.url(),
  newAccount: z.url(),
  newOrder: z.url(),
});

const ChallengeSchema = z.object({
  type: z.string(),
  url: z.url(),
  token: z.string().regex(TOKEN).optional(),
  status: z.string(),
  error: ProblemSchema.optional(),
});

const AuthorizationSchema = z.object({
  status: z.string(),
  identifier: z.object({ value: z.string() }),
  challenges: z.array(ChallengeSchema),
});

const OrderSchema = z.object({
  status: z.string(),
  authorizations: z.array(z.url()),
  finalize: z.url(),
  certificate: z.url().optional(),
  error: ProblemSchema.optional(),
});
type Order = z.infer<typeof OrderSchema>;

const BAD_NONCE = "urn:ietf:params:acme:error:badNonce";

export interface Polling {
  /** The first wait between polls, doubling after each. */
  firstMs: number;
  /** The most all the waits for one thing add up to. */
  limitMs: number;
}

const POLLING: Polling = { firstMs: 1000, limitMs: 60_000 };

/** One account's requests to one directory. */
interface SessionOptions {
  directoryUrl: string;
  key: KeyObject;
  jwk: JWK;
  context: Context;
  signal?: AbortSignal | undefined;
}

class Session {
  private nonce: string | null = null;
  private kid: string | null = null;
  private directory: z.infer<typeof DirectorySchema> | null = null;
  private readonly o: SessionOptions;

  constructor(o: SessionOptions) {
    this.o = o;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          "user-agent": USER_AGENT,
          ...(init.headers as Record<string, string> | undefined),
        },
        ...(this.o.signal ? { signal: this.o.signal } : {}),
      });
    } catch (err) {
      if (this.o.signal?.aborted) throw err;
      const cause = (err as { cause?: { code?: string } }).cause;
      throw new AcmeError(
        `can't reach ${this.o.context.ca} at ${url}${cause?.code ? ` (${cause.code})` : ""}`,
      );
    }
    const nonce = res.headers.get("replay-nonce");
    if (nonce) this.nonce = nonce;
    return res;
  }

  private unexpected(what: string): AcmeError {
    return new AcmeError(
      `${this.o.context.ca} sent an answer this gateway can't read (${what})`,
    );
  }

  async open(): Promise<void> {
    const res = await this.send(this.o.directoryUrl, { method: "GET" });
    const parsed = DirectorySchema.safeParse(
      res.ok ? await res.json().catch(() => null) : null,
    );
    if (!parsed.success) throw this.unexpected(`directory, ${res.status}`);
    this.directory = parsed.data;
  }

  private dir(): z.infer<typeof DirectorySchema> {
    if (!this.directory) throw new Error("the session isn't open");
    return this.directory;
  }

  private async freshNonce(): Promise<string> {
    if (this.nonce) {
      const nonce = this.nonce;
      this.nonce = null;
      return nonce;
    }
    await this.send(this.dir().newNonce, { method: "HEAD" });
    const nonce = this.nonce as string | null;
    this.nonce = null;
    if (!nonce) throw this.unexpected("no nonce");
    return nonce;
  }

  /**
   * A signed POST; `payload` null is POST-as-GET. A problem throws, with one
   * retry on a nonce the server refused.
   */
  async post(
    url: string,
    payload: unknown,
    o: { accept?: string; fromChallenge?: boolean } = {},
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const header = {
        alg: "ES256",
        nonce: await this.freshNonce(),
        url,
        ...(this.kid ? { kid: this.kid } : { jwk: this.o.jwk }),
      };
      const body = await new FlattenedSign(
        payload === null
          ? new Uint8Array()
          : new TextEncoder().encode(JSON.stringify(payload)),
      )
        .setProtectedHeader(header)
        .sign(this.o.key);
      const res = await this.send(url, {
        method: "POST",
        headers: {
          "content-type": "application/jose+json",
          ...(o.accept ? { accept: o.accept } : {}),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      const problem = ProblemSchema.safeParse(
        await res.json().catch(() => null),
      );
      if (!problem.success) throw this.unexpected(`${res.status}`);
      if (problem.data.type === BAD_NONCE && attempt === 0) continue;
      throw failure(problem.data, this.o.context, o.fromChallenge ?? false);
    }
  }

  async json<T>(
    schema: z.ZodType<T>,
    url: string,
    payload: unknown,
    what: string,
  ): Promise<{ value: T; location: string | null }> {
    const res = await this.post(url, payload);
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw this.unexpected(what);
    return { value: parsed.data, location: res.headers.get("location") };
  }

  /** Create the account, or find the one this key already has. */
  async account(): Promise<void> {
    const res = await this.post(this.dir().newAccount, {
      termsOfServiceAgreed: true,
    });
    const location = res.headers.get("location");
    if (!location) throw this.unexpected("account without a location");
    await res.body?.cancel();
    this.kid = location;
  }

  async newOrder(names: readonly string[]): Promise<{
    order: Order;
    url: string;
  }> {
    const { value, location } = await this.json(
      OrderSchema,
      this.dir().newOrder,
      { identifiers: names.map((value) => ({ type: "dns", value })) },
      "order",
    );
    if (!location) throw this.unexpected("order without a location");
    return { order: value, url: location };
  }
}

export interface AcmeOptions {
  directoryUrl: string;
  /** The host names to certify. */
  names: readonly string[];
  /** Where the account key, the certificate and its key are kept. */
  dir: string;
  /** Where the challenge listener finds what to answer. */
  challenges: ChallengeTokens;
  /**
   * The challenge listener's port, for the sentence when port 80 fails;
   * null when challenges come through the relay.
   */
  httpPort: number | null;
  signal?: AbortSignal;
  polling?: Polling;
}

/**
 * Get a certificate for `names` and keep it in `dir`: an account (made
 * once), an order, an HTTP-01 challenge per name, then the certificate for a
 * new P-256 key. Throws an AcmeError whose message says what to fix.
 */
export async function obtainCertificate(
  o: AcmeOptions,
): Promise<StoredCertificate> {
  const context: Context = {
    ca: authorityName(o.directoryUrl),
    host: o.names[0] ?? "",
    httpPort: o.httpPort,
  };
  const polling = o.polling ?? POLLING;
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  const key = accountKey(o.dir);
  const jwk = await exportJWK(createPublicKey(key));
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const thumbprint = await calculateJwkThumbprint(publicJwk);
  const session = new Session({
    directoryUrl: o.directoryUrl,
    key,
    jwk: publicJwk,
    context,
    signal: o.signal,
  });

  /** Fetch with `get` until `done`, waiting 1 s, 2 s, 4 s… up to the limit. */
  const poll = async <T>(
    get: () => Promise<T>,
    done: (v: T) => boolean,
    what: string,
  ): Promise<T> => {
    const until = Date.now() + polling.limitMs;
    for (let wait = polling.firstMs; ; wait *= 2) {
      const v = await get();
      if (done(v)) return v;
      const left = until - Date.now();
      if (left <= 0) {
        throw new AcmeError(
          `${context.ca} took longer than ${Math.round(polling.limitMs / 1000)} s to ${what}`,
        );
      }
      await sleep(Math.min(wait, left), undefined, {
        ...(o.signal ? { signal: o.signal } : {}),
      });
    }
  };

  await session.open();
  await session.account();
  let { order, url: orderUrl } = await session.newOrder(o.names);
  const getOrder = async () =>
    (await session.json(OrderSchema, orderUrl, null, "order")).value;

  for (const authzUrl of order.authorizations) {
    const getAuthz = async () =>
      (await session.json(AuthorizationSchema, authzUrl, null, "authorization"))
        .value;
    const authz = await getAuthz();
    if (authz.status === "valid") continue;
    const challenge = authz.challenges.find((c) => c.type === "http-01");
    if (authz.status !== "pending" || !challenge?.token) {
      throw new AcmeError(
        `${context.ca} offers no HTTP challenge for ${authz.identifier.value} (${authz.status})`,
      );
    }
    o.challenges.publish(challenge.token, `${challenge.token}.${thumbprint}`);
    try {
      await session.post(challenge.url, {}, { fromChallenge: true });
      const done = await poll(
        getAuthz,
        (a) => a.status !== "pending" && a.status !== "processing",
        `check ${authz.identifier.value}`,
      );
      if (done.status !== "valid") {
        const error = done.challenges.find((c) => c.type === "http-01")?.error;
        if (error) throw failure(error, context, true);
        throw new AcmeError(
          `${context.ca} didn't accept the challenge for ${authz.identifier.value} (${done.status})`,
        );
      }
    } finally {
      o.challenges.withdraw(challenge.token);
    }
  }

  order = await poll(
    getOrder,
    (v) => v.status !== "pending",
    "accept the challenges",
  );
  if (order.status !== "ready" && order.status !== "valid") {
    if (order.error) throw failure(order.error, context, false);
    throw new AcmeError(`${context.ca} refused the order (${order.status})`);
  }

  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  if (order.status === "ready") {
    const csr = certificateRequest(privateKey, o.names);
    order = (
      await session.json(
        OrderSchema,
        order.finalize,
        { csr: csr.toString("base64url") },
        "finalized order",
      )
    ).value;
    order = await poll(
      getOrder,
      (v) => v.status !== "processing" && v.status !== "ready",
      "issue the certificate",
    );
  }
  if (order.status !== "valid" || !order.certificate) {
    if (order.error) throw failure(order.error, context, false);
    throw new AcmeError(
      `${context.ca} issued no certificate (${order.status})`,
    );
  }
  const res = await session.post(order.certificate, null, {
    accept: "application/pem-certificate-chain",
  });
  const issued: StoredCertificate = {
    cert: await res.text(),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(issued.cert);
  } catch {
    throw new AcmeError(
      `${context.ca} sent a certificate this gateway can't read`,
    );
  }
  if (
    !leaf.checkPrivateKey(privateKey) ||
    !o.names.every((n) => leaf.checkHost(n))
  ) {
    throw new AcmeError(
      `${context.ca} sent a certificate for another key or name`,
    );
  }
  storeCertificate(o.dir, issued);
  return issued;
}
