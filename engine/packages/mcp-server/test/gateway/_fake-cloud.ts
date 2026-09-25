// A stand-in control plane for gateway tests: an in-process HTTP server that
// speaks the link protocol with the SAME module the real control plane imports
// (encodeBundle, verifyRequestToken, …). It is strict where the real one must
// be — every request token is verified against the registered key, audience,
// method, path and body — so a gateway that signs anything wrongly fails here.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  RequestTokenError,
  b64urlEncode,
  encodeApprovalOutcome,
  encodeBundle,
  encodeEnrollmentResponse,
  hashEnrollmentToken,
  mintEnrollmentToken,
  publicKeyFromRaw,
  readRequestTokenKid,
  sqlSha256,
  verifyEnrollmentProof,
  verifyRequestToken,
} from "../../src/gateway/protocol.ts";
import { testKey, type TestKey } from "./_fixtures.ts";

export const FAKE_PROJECT = "01J8Z6Q3PROJECTAAAAAAAAAAA";

interface Gateway {
  id: string;
  publicKeyRaw: Buffer;
  revoked: boolean;
}

export class FakeCloud {
  readonly bundleKey: TestKey = testKey();
  readonly projectId = FAKE_PROJECT;
  /** Published bundles, oldest first. The latest is what GET bundle serves. */
  readonly published: string[] = [];
  /** When set, served instead of the latest published bundle, ignoring
   *  If-None-Match — how a test plays a hostile or broken response. */
  override: string | null = null;
  readonly heartbeats: Array<Record<string, unknown>> = [];
  readonly approvalRequests: Array<Record<string, unknown>> = [];
  readonly gateways = new Map<string, Gateway>();
  readonly requests: string[] = [];
  private readonly tokens = new Map<string, { gatewayId: string | null }>();
  private nextGateway = 1;
  private server!: Server;
  origin = "";

  static async start(): Promise<FakeCloud> {
    const cloud = new FakeCloud();
    cloud.server = createServer((req, res) => {
      cloud.handle(req, res).catch((err) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve) => cloud.server.listen(0, "127.0.0.1", resolve));
    const addr = cloud.server.address();
    if (!addr || typeof addr !== "object") throw new Error("no address");
    cloud.origin = `http://127.0.0.1:${addr.port}`;
    return cloud;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get latestVersion(): number {
    return this.published.length;
  }

  mintToken(pinKey: Buffer = this.bundleKey.raw): string {
    const token = mintEnrollmentToken(pinKey);
    this.tokens.set(hashEnrollmentToken(token), { gatewayId: null });
    return token;
  }

  publish(policy: string, opts: { paused?: boolean; crit?: string[]; extra?: Record<string, unknown> } = {}): string {
    const jws = this.sign(this.latestVersion + 1, policy, opts);
    this.published.push(jws);
    return jws;
  }

  /** A bundle signed by the real key but not published — for replay tests. */
  sign(
    version: number,
    policy: string,
    opts: { paused?: boolean; crit?: string[]; extra?: Record<string, unknown>; projectId?: string; key?: TestKey } = {},
  ): string {
    const key = opts.key ?? this.bundleKey;
    return encodeBundle(
      {
        iss: this.origin,
        project_id: opts.projectId ?? this.projectId,
        version,
        iat: Math.floor(Date.now() / 1000),
        paused: opts.paused ?? false,
        policy,
        crit: opts.crit,
      },
      { kid: key.kid, privateKey: key.privateKey },
      opts.extra,
    );
  }

  revoke(gatewayId: string): void {
    this.gateways.get(gatewayId)!.revoked = true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0]!;
    const method = req.method ?? "GET";
    this.requests.push(`${method} ${path}`);
    const body = await readBody(req);
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";

    if (method === "POST" && path === "/api/gateway/v1/enroll") {
      let proof;
      try {
        proof = verifyEnrollmentProof(bearer, { audience: this.origin, method, path, body });
      } catch {
        return json(res, 401, { error: "unauthorized" });
      }
      const { token } = JSON.parse(body) as { token: string };
      const entry = this.tokens.get(hashEnrollmentToken(token));
      if (!entry) return json(res, 401, { error: "enrollment_token_invalid" });
      let gw: Gateway | undefined;
      if (entry.gatewayId) {
        gw = this.gateways.get(entry.gatewayId)!;
        // A retry after a lost response: same key, same gateway. Anyone else: no.
        if (!gw.publicKeyRaw.equals(proof.publicKeyRaw)) return json(res, 401, { error: "enrollment_token_used" });
      } else {
        gw = { id: `01GATEWAY${String(this.nextGateway++).padStart(17, "0")}`, publicKeyRaw: proof.publicKeyRaw, revoked: false };
        this.gateways.set(gw.id, gw);
        entry.gatewayId = gw.id;
      }
      const jws = encodeEnrollmentResponse(
        {
          iss: this.origin,
          project_id: this.projectId,
          gateway_id: gw.id,
          gateway_key: b64urlEncode(gw.publicKeyRaw),
          signing_keys: [{ kid: this.bundleKey.kid, x: b64urlEncode(this.bundleKey.raw) }],
          min_version: Math.max(this.latestVersion, 1),
          poll_seconds: 15,
          iat: Math.floor(Date.now() / 1000),
        },
        { kid: this.bundleKey.kid, privateKey: this.bundleKey.privateKey },
      );
      res.statusCode = 200;
      res.setHeader("content-type", "application/jose");
      res.end(jws);
      return;
    }

    // Every other route: a request token from a registered, unrevoked gateway.
    const gw = this.authenticate(bearer, method, path, method === "GET" ? undefined : body, res);
    if (!gw) return;

    if (method === "GET" && path === "/api/gateway/v1/bundle") {
      if (this.override !== null) return jose(res, this.override);
      if (this.latestVersion === 0) return json(res, 404, { error: "no_bundle" });
      const inm = req.headers["if-none-match"];
      if (inm === `"${this.latestVersion}"`) {
        res.statusCode = 304;
        res.end();
        return;
      }
      return jose(res, this.published.at(-1)!);
    }
    if (method === "POST" && path === "/api/gateway/v1/heartbeat") {
      this.heartbeats.push(JSON.parse(body) as Record<string, unknown>);
      res.statusCode = 204;
      res.end();
      return;
    }
    if (method === "POST" && path === "/api/gateway/v1/approvals") {
      const held = JSON.parse(body) as { query_id: string; sql: string };
      this.approvalRequests.push(held as unknown as Record<string, unknown>);
      // Signed and bound to the statement, as a gateway requires.
      const iat = Math.floor(Date.now() / 1000);
      return jose(
        res,
        encodeApprovalOutcome(
          {
            iss: this.origin,
            project_id: this.projectId,
            gateway_id: gw.id,
            query_id: held.query_id,
            sql_sha256: sqlSha256(held.sql),
            iat,
            exp: iat + 60,
            outcome: { status: "approved", by: "ada@example.com", note: null },
          },
          { kid: this.bundleKey.kid, privateKey: this.bundleKey.privateKey },
        ),
      );
    }
    if (method === "POST" && path === "/api/gateway/v1/approvals/status") {
      return json(res, 200, { status: "expired" });
    }
    json(res, 404, { error: "not_found" });
  }

  private authenticate(
    token: string,
    method: string,
    path: string,
    body: string | undefined,
    res: ServerResponse,
  ): Gateway | null {
    let gw: Gateway | undefined;
    try {
      gw = this.gateways.get(readRequestTokenKid(token));
      if (!gw) throw new RequestTokenError("claims", "unknown gateway");
      if (gw.revoked) {
        json(res, 401, { error: "gateway_revoked" });
        return null;
      }
      verifyRequestToken(token, publicKeyFromRaw(gw.publicKeyRaw), { audience: this.origin, method, path, body });
      return gw;
    } catch (err) {
      const code = err instanceof RequestTokenError && err.code === "clock_skew" ? "clock_skew" : "unauthorized";
      json(res, 401, { error: code, server_time: Math.floor(Date.now() / 1000) });
      return null;
    }
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function jose(res: ServerResponse, jws: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "application/jose");
  res.end(jws);
}
