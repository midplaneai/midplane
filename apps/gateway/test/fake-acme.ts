// A stand-in for an ACME certificate authority (RFC 8555), so the gateway's
// client is tested within oss/ alone. Like a real one it verifies every
// JWS (the account's key, a nonce it issued and used once, the URL signed),
// fetches each HTTP-01 token from the challenge listener with the name as
// Host, checks the certificate request's signature and names, and issues
// from a CA of its own, built with the gateway's DER writer. Pebble stands
// in for Let's Encrypt in the package smoke; this one counts orders and can
// be told to fail, refuse a nonce or issue short-lived certificates.

import {
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  type FlattenedJWSInput,
  flattenedVerify,
  importJWK,
  type JWK,
} from "jose";
import { type AcmeProblem, der, tlv } from "../src/acme.ts";

const ERROR = "urn:ietf:params:acme:error:";
const DAY_MS = 24 * 60 * 60 * 1000;

// ── DER, read and written ──────────────────────────────────────────────────

interface Node {
  tag: number;
  /** Where the value starts, its header included. */
  start: number;
  /** Where its contents start. */
  body: number;
  end: number;
}

function readNode(buf: Buffer, at: number): Node {
  const tag = buf[at] as number;
  let length = buf[at + 1] as number;
  let body = at + 2;
  if (length & 0x80) {
    const n = length & 0x7f;
    length = 0;
    for (let i = 0; i < n; i++)
      length = length * 256 + (buf[body + i] as number);
    body += n;
  }
  return { tag, start: at, body, end: body + length };
}

function children(buf: Buffer, node: Node): Node[] {
  const out: Node[] = [];
  for (let at = node.body; at < node.end; ) {
    const child = readNode(buf, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

/** An OID value as hex, its tag and length included, to compare. */
const oidOf = (buf: Buffer, node: Node) =>
  buf.subarray(node.start, node.end).toString("hex");

/** What a certificate request holds, once its signature checks out. */
function readRequest(csr: Buffer): { key: KeyObject; names: string[] } {
  const top = readNode(csr, 0);
  const [info, , signature] = children(csr, top);
  if (!info || !signature) throw new Error("not a certificate request");
  const [, , spki, attributes] = children(csr, info);
  if (!spki || !attributes) throw new Error("no public key or attributes");
  const key = createPublicKey({
    key: csr.subarray(spki.start, spki.end),
    format: "der",
    type: "spki",
  });
  const ok = verify(
    "sha256",
    csr.subarray(info.start, info.end),
    { key, dsaEncoding: "der" },
    csr.subarray(signature.body + 1, signature.end),
  );
  if (!ok) throw new Error("the request's signature doesn't verify");
  const san = der.oid(der.OID.subjectAltName).toString("hex");
  const names: string[] = [];
  // [0] { Attribute { oid, SET { Extensions { Extension { oid, OCTET STRING } } } } }
  for (const attribute of children(csr, attributes)) {
    const [, values] = children(csr, attribute);
    for (const extensions of values ? children(csr, values) : []) {
      for (const extension of children(csr, extensions)) {
        const parts = children(csr, extension);
        const id = parts[0];
        const value = parts.at(-1);
        if (!id || !value || oidOf(csr, id) !== san) continue;
        const inner = csr.subarray(value.body, value.end);
        for (const name of children(inner, readNode(inner, 0))) {
          if (name.tag === 0x82) {
            names.push(inner.subarray(name.body, name.end).toString("ascii"));
          }
        }
      }
    }
  }
  return { key, names };
}

const nameOf = (cn: string) =>
  der.sequence(
    der.set(der.sequence(der.oid(der.OID.commonName), der.utf8String(cn))),
  );

/** UTCTime, YYMMDDHHMMSSZ. */
const timeOf = (d: Date) =>
  tlv(
    0x17,
    Buffer.from(
      d.toISOString().replace(/[-:T]/g, "").slice(2, 14).concat("Z"),
      "ascii",
    ),
  );

const extension = (id: string, value: Buffer, critical = false) =>
  der.sequence(
    der.oid(id),
    ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []),
    der.octetString(value),
  );

function certificate(o: {
  issuer: string;
  subject: string;
  key: KeyObject;
  signer: KeyObject;
  notBefore: Date;
  notAfter: Date;
  ca: boolean;
  names?: readonly string[];
}): string {
  const serial = randomBytes(16);
  // Positive, and minimal: no leading zero byte for DER to refuse.
  serial[0] = ((serial[0] as number) & 0x3f) | 0x40;
  const publicKey = o.key.type === "public" ? o.key : createPublicKey(o.key);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const tbs = der.sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))), // v3
    tlv(0x02, serial),
    der.sequence(der.oid(der.OID.ecdsaWithSha256)),
    nameOf(o.issuer),
    der.sequence(timeOf(o.notBefore), timeOf(o.notAfter)),
    nameOf(o.subject),
    spki,
    tlv(
      0xa3,
      der.sequence(
        extension(
          der.OID.basicConstraints,
          o.ca ? der.sequence(tlv(0x01, Buffer.from([0xff]))) : der.sequence(),
          true,
        ),
        ...(o.names
          ? [
              extension(
                der.OID.subjectAltName,
                der.sequence(...o.names.map(der.dnsName)),
              ),
            ]
          : []),
      ),
    ),
  );
  const signature = sign("sha256", tbs, { key: o.signer, dsaEncoding: "der" });
  const body = der
    .sequence(
      tbs,
      der.sequence(der.oid(der.OID.ecdsaWithSha256)),
      der.bitString(signature),
    )
    .toString("base64")
    .replace(/.{64}/g, "$&\n");
  return `-----BEGIN CERTIFICATE-----\n${body.trimEnd()}\n-----END CERTIFICATE-----\n`;
}

// ── the directory ──────────────────────────────────────────────────────────

interface Authz {
  name: string;
  token: string;
  status: "pending" | "processing" | "valid" | "invalid";
  error: AcmeProblem | null;
  thumbprint: string;
}

interface Order {
  names: string[];
  authzs: string[];
  status: "pending" | "ready" | "processing" | "valid" | "invalid";
  cert: string | null;
  account: string;
}

export interface FakeAcme {
  /** The directory URL. */
  url: string;
  /** The CA's certificate, to trust what it issues. */
  ca: string;
  /** Every newOrder accepted. */
  newOrders: number;
  /** Every certificate issued, leaf first in each chain, newest last. */
  issued: X509Certificate[];
  /** Days the next certificate is valid for. */
  validDays: number;
  /** When set, every validation fails with this problem. */
  failValidation: AcmeProblem | null;
  /** When set, the next signed request's nonce is refused once. */
  rejectNextNonce: boolean;
  /** Nonces refused so far. */
  badNonces: number;
  /** The port that stands in for port 80: where tokens are fetched. */
  challengePort: number;
  /** Every token fetch: its path and Host, and what came back. */
  fetches: { path: string; status: number; body: string }[];
  /** The User-Agent of the last request; one without is refused, as Pebble does. */
  userAgent: string | null;
  close(): Promise<void>;
}

export async function startFakeAcme(
  o: { challengePort?: number } = {},
): Promise<FakeAcme> {
  const caKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const now = Date.now();
  const caPem = certificate({
    issuer: "Fake ACME CA",
    subject: "Fake ACME CA",
    key: caKey,
    signer: caKey,
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + 3650 * DAY_MS),
    ca: true,
  });
  const nonces = new Set<string>();
  const accounts = new Map<string, { jwk: JWK; thumbprint: string }>();
  const authzs = new Map<string, Authz>();
  const orders = new Map<string, Order>();
  const certs = new Map<string, string>();
  let base = "";
  const id = () => randomBytes(8).toString("hex");

  const fake: FakeAcme = {
    url: "",
    ca: caPem,
    newOrders: 0,
    issued: [],
    validDays: 90,
    failValidation: null,
    rejectNextNonce: false,
    badNonces: 0,
    challengePort: o.challengePort ?? 0,
    fetches: [],
    userAgent: null,
    close: async () => {},
  };

  const nonce = () => {
    const n = randomBytes(12).toString("base64url");
    nonces.add(n);
    return n;
  };

  const reply = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
      "replay-nonce": nonce(),
      "cache-control": "no-store",
      "content-type":
        typeof body === "string"
          ? "application/pem-certificate-chain"
          : status >= 400
            ? "application/problem+json"
            : "application/json",
      ...headers,
    });
    res.end(text);
  };
  const problem = (
    res: ServerResponse,
    status: number,
    type: string,
    detail: string,
  ) => reply(res, status, { type: `${ERROR}${type}`, detail });

  const orderStatus = (order: Order): Order["status"] => {
    if (order.status === "valid" || order.status === "invalid") {
      return order.status;
    }
    const states = order.authzs.map((a) => authzs.get(a)?.status);
    if (states.some((s) => s === "invalid")) return "invalid";
    if (order.status === "pending" && states.every((s) => s === "valid")) {
      return "ready";
    }
    return order.status;
  };
  const orderJson = (orderId: string) => {
    const order = orders.get(orderId) as Order;
    order.status = orderStatus(order);
    return {
      status: order.status,
      identifiers: order.names.map((value) => ({ type: "dns", value })),
      authorizations: order.authzs.map((a) => `${base}/authz/${a}`),
      finalize: `${base}/finalize/${orderId}`,
      ...(order.cert ? { certificate: `${base}/cert/${order.cert}` } : {}),
    };
  };
  const authzJson = (authzId: string) => {
    const a = authzs.get(authzId) as Authz;
    return {
      status: a.status,
      identifier: { type: "dns", value: a.name },
      challenges: [
        // A DNS challenge first: the client must pick HTTP-01.
        {
          type: "dns-01",
          url: `${base}/chall/dns-${authzId}`,
          token: a.token,
          status: "pending",
        },
        {
          type: "http-01",
          url: `${base}/chall/${authzId}`,
          token: a.token,
          status: a.status === "invalid" ? "invalid" : a.status,
          ...(a.error ? { error: a.error } : {}),
        },
      ],
    };
  };

  /** Fetch the token from the challenge listener, as a CA does from port 80. */
  const validate = async (a: Authz) => {
    if (fake.failValidation) {
      a.status = "invalid";
      a.error = fake.failValidation;
      return;
    }
    const path = `/.well-known/acme-challenge/${a.token}`;
    try {
      const res = await fetch(`http://127.0.0.1:${fake.challengePort}${path}`, {
        headers: { host: a.name },
      });
      const body = await res.text();
      fake.fetches.push({ path, status: res.status, body });
      if (res.status === 200 && body === `${a.token}.${a.thumbprint}`) {
        a.status = "valid";
      } else {
        a.status = "invalid";
        a.error = {
          type: `${ERROR}unauthorized`,
          detail: `Invalid response from http://${a.name}${path}: ${res.status}`,
        };
      }
    } catch {
      a.status = "invalid";
      a.error = {
        type: `${ERROR}connection`,
        detail: `Connection refused at ${a.name}:80`,
      };
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "/";
    const agent = req.headers["user-agent"];
    if (!agent) {
      return problem(
        res,
        400,
        "malformed",
        "All requests MUST include a User-Agent header",
      );
    }
    fake.userAgent = agent;
    if (req.method === "GET" && path === "/dir") {
      return reply(res, 200, {
        newNonce: `${base}/nonce`,
        newAccount: `${base}/account`,
        newOrder: `${base}/order`,
        meta: { termsOfService: `${base}/terms` },
      });
    }
    if (path === "/nonce" && (req.method === "HEAD" || req.method === "GET")) {
      return reply(res, req.method === "HEAD" ? 200 : 204, "");
    }
    if (req.method !== "POST") return problem(res, 405, "malformed", "POST");

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const jws = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as FlattenedJWSInput;
    if (req.headers["content-type"] !== "application/jose+json") {
      return problem(res, 415, "malformed", "content-type");
    }
    const header = decodeProtectedHeader(jws) as {
      nonce?: string;
      url?: string;
      jwk?: JWK;
      kid?: string;
      alg?: string;
    };
    if (fake.rejectNextNonce || !header.nonce || !nonces.has(header.nonce)) {
      fake.rejectNextNonce = false;
      fake.badNonces++;
      return problem(
        res,
        400,
        "badNonce",
        "JWS has an invalid anti-replay nonce",
      );
    }
    nonces.delete(header.nonce);
    if (header.url !== `${base}${path}` || header.alg !== "ES256") {
      return problem(res, 400, "malformed", "url or alg");
    }
    let account: { jwk: JWK; thumbprint: string; id: string };
    if (path === "/account") {
      if (!header.jwk || header.kid) {
        return problem(res, 400, "malformed", "newAccount takes a jwk");
      }
      const thumbprint = await calculateJwkThumbprint(header.jwk);
      account = { jwk: header.jwk, thumbprint, id: thumbprint };
    } else {
      const kid = header.kid?.replace(`${base}/acct/`, "");
      const known = kid ? accounts.get(kid) : undefined;
      if (header.jwk || !kid || !known) {
        return problem(res, 401, "accountDoesNotExist", "unknown kid");
      }
      account = { ...known, id: kid };
    }
    let payloadBytes: Uint8Array;
    try {
      payloadBytes = (
        await flattenedVerify(jws, await importJWK(account.jwk, "ES256"))
      ).payload;
    } catch {
      return problem(res, 400, "malformed", "signature");
    }
    const payload =
      payloadBytes.length === 0
        ? null
        : (JSON.parse(Buffer.from(payloadBytes).toString("utf8")) as Record<
            string,
            unknown
          >);

    if (path === "/account") {
      if (payload?.termsOfServiceAgreed !== true) {
        return problem(res, 400, "userActionRequired", "agree to the terms");
      }
      const existed = accounts.has(account.id);
      accounts.set(account.id, {
        jwk: account.jwk,
        thumbprint: account.thumbprint,
      });
      return reply(
        res,
        existed ? 200 : 201,
        { status: "valid" },
        { location: `${base}/acct/${account.id}` },
      );
    }
    if (path === "/order") {
      const identifiers = (payload?.identifiers ?? []) as { value: string }[];
      fake.newOrders++;
      const orderId = id();
      const order: Order = {
        names: identifiers.map((i) => i.value),
        authzs: [],
        status: "pending",
        cert: null,
        account: account.id,
      };
      for (const name of order.names) {
        const authzId = id();
        authzs.set(authzId, {
          name,
          token: randomBytes(16).toString("base64url"),
          status: "pending",
          error: null,
          thumbprint: account.thumbprint,
        });
        order.authzs.push(authzId);
      }
      orders.set(orderId, order);
      return reply(res, 201, orderJson(orderId), {
        location: `${base}/order/${orderId}`,
      });
    }
    const [, kind, ref = ""] = path.split("/");
    if (kind === "authz" && authzs.has(ref) && payload === null) {
      return reply(res, 200, authzJson(ref));
    }
    if (kind === "chall" && authzs.has(ref)) {
      const a = authzs.get(ref) as Authz;
      if (a.status === "pending") {
        a.status = "processing";
        setTimeout(() => void validate(a), 5);
      }
      return reply(res, 200, authzJson(ref).challenges[1]);
    }
    if (kind === "order" && orders.has(ref) && payload === null) {
      return reply(res, 200, orderJson(ref));
    }
    if (kind === "finalize" && orders.has(ref)) {
      const order = orders.get(ref) as Order;
      if (orderStatus(order) !== "ready") {
        return problem(res, 403, "orderNotReady", order.status);
      }
      let request: { key: KeyObject; names: string[] };
      try {
        request = readRequest(Buffer.from(String(payload?.csr), "base64url"));
      } catch (err) {
        return problem(res, 400, "badCSR", (err as Error).message);
      }
      if ([...request.names].sort().join() !== [...order.names].sort().join()) {
        return problem(res, 400, "badCSR", `names ${request.names.join()}`);
      }
      const issuedAt = Date.now();
      const leaf = certificate({
        issuer: "Fake ACME CA",
        subject: order.names[0] as string,
        key: request.key,
        signer: caKey,
        notBefore: new Date(issuedAt - 60 * 60 * 1000),
        notAfter: new Date(issuedAt + fake.validDays * DAY_MS),
        ca: false,
        names: order.names,
      });
      const certId = id();
      certs.set(certId, `${leaf}${caPem}`);
      fake.issued.push(new X509Certificate(leaf));
      order.cert = certId;
      order.status = "valid";
      return reply(res, 200, orderJson(ref));
    }
    if (kind === "cert" && certs.has(ref) && payload === null) {
      return reply(res, 200, certs.get(ref) as string);
    }
    return problem(res, 404, "malformed", `no ${path}`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) problem(res, 500, "serverInternal", String(err));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.url = `${base}/dir`;
  fake.close = () =>
    new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  return fake;
}

/**
 * A self-signed certificate for `names` and its key (PEM), valid from
 * `notBefore` (an hour ago) to `notAfter` (90 days on).
 */
export function testCertificate(o: {
  names: readonly string[];
  notBefore?: Date;
  notAfter?: Date;
}): { cert: string; key: string } {
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  const now = Date.now();
  return {
    cert: certificate({
      issuer: o.names[0] as string,
      subject: o.names[0] as string,
      key,
      signer: key,
      notBefore: o.notBefore ?? new Date(now - 60 * 60 * 1000),
      notAfter: o.notAfter ?? new Date(now + 90 * DAY_MS),
      ca: false,
      names: o.names,
    }),
    key: key.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
