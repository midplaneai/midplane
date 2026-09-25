// HTTP client for the gateway → control plane link. Every call is outbound and
// starts here; nothing on the control plane ever dials a gateway.
//
// Each request carries a fresh request token signed by the gateway key and bound
// to that request's method, path and body (request-token.ts). Redirects are
// never followed — a token is bound to one path, and a redirect is either a
// misconfiguration or someone steering the gateway — and every call has a
// deadline. Results are values, not throws, so the pull loop can tell "nothing
// new", "here is a bundle" and each kind of failure apart.

import type { KeyObject } from "node:crypto";
import { mintEnrollmentProof, mintRequestToken } from "./protocol.ts";

export const ENROLL_PATH = "/api/gateway/v1/enroll";
export const BUNDLE_PATH = "/api/gateway/v1/bundle";
export const HEARTBEAT_PATH = "/api/gateway/v1/heartbeat";
export const APPROVALS_PATH = "/api/gateway/v1/approvals";

const REQUEST_TIMEOUT_MS = 10_000;

export interface LinkFailure {
  kind: "error";
  /** HTTP status, or null when no response arrived (network, timeout). */
  status: number | null;
  /** The control plane's `error` code when it sent one (e.g. gateway_revoked,
   *  clock_skew, enrollment_token_used). */
  code: string | null;
  message: string;
  /** The control plane's clock, when it reported one (clock_skew). */
  serverTime: number | null;
}

export type BundleFetch = { kind: "not_modified" } | { kind: "bundle"; jws: string } | LinkFailure;

export interface GatewaySigner {
  gatewayId: string;
  /** The pinned issuer — the audience of every request token. */
  audience: string;
  privateKey: KeyObject;
}

export class LinkClient {
  constructor(
    private readonly cloudUrl: string,
    private readonly userAgent: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** POST enroll, proving possession of the key being registered. Returns the
   *  signed enrollment response (verify it with verifyEnrollmentResponse). */
  async enroll(
    body: Record<string, unknown>,
    key: { privateKey: KeyObject; publicKeyRaw: Uint8Array },
  ): Promise<{ kind: "enrolled"; jws: string } | LinkFailure> {
    const text = JSON.stringify(body);
    const proof = mintEnrollmentProof({
      audience: this.cloudUrl,
      method: "POST",
      path: ENROLL_PATH,
      body: text,
      publicKeyRaw: key.publicKeyRaw,
      privateKey: key.privateKey,
    });
    const res = await this.send("POST", ENROLL_PATH, proof, text);
    if (res.kind === "error") return res;
    if (res.response.status !== 200) return failure(res.response);
    return { kind: "enrolled", jws: (await res.response.text()).trim() };
  }

  async fetchBundle(signer: GatewaySigner, currentVersion: number | null): Promise<BundleFetch> {
    const token = this.token(signer, "GET", BUNDLE_PATH);
    const headers: Record<string, string> = {};
    if (currentVersion !== null) headers["if-none-match"] = `"${currentVersion}"`;
    const res = await this.send("GET", BUNDLE_PATH, token, undefined, headers);
    if (res.kind === "error") return res;
    if (res.response.status === 304) return { kind: "not_modified" };
    if (res.response.status !== 200) return failure(res.response);
    return { kind: "bundle", jws: (await res.response.text()).trim() };
  }

  async heartbeat(signer: GatewaySigner, body: unknown): Promise<{ kind: "ok" } | LinkFailure> {
    const text = JSON.stringify(body);
    const res = await this.send("POST", HEARTBEAT_PATH, this.token(signer, "POST", HEARTBEAT_PATH, text), text);
    if (res.kind === "error") return res;
    if (res.response.status >= 200 && res.response.status < 300) return { kind: "ok" };
    return failure(res.response);
  }

  /** Authorization header value for an arbitrary signed call (the approval
   *  gate builds its own requests and asks for this per call). */
  authorization(signer: GatewaySigner, method: string, path: string, body?: string): string {
    return `Bearer ${this.token(signer, method, path, body)}`;
  }

  private token(signer: GatewaySigner, method: string, path: string, body?: string): string {
    return mintRequestToken({
      gatewayId: signer.gatewayId,
      audience: signer.audience,
      method,
      path,
      body,
      privateKey: signer.privateKey,
    });
  }

  private async send(
    method: string,
    path: string,
    token: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ kind: "response"; response: Response } | LinkFailure> {
    try {
      const response = await this.fetchImpl(`${this.cloudUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "user-agent": this.userAgent,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...extraHeaders,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        return {
          kind: "error",
          status: response.status,
          code: "redirect",
          message: `control plane answered ${path} with a redirect (${response.status}); a gateway never follows redirects`,
          serverTime: null,
        };
      }
      return { kind: "response", response };
    } catch (err) {
      return {
        kind: "error",
        status: null,
        code: null,
        message: `control plane unreachable: ${err instanceof Error ? err.message : String(err)}`,
        serverTime: null,
      };
    }
  }
}

async function failure(res: Response): Promise<LinkFailure> {
  let code: string | null = null;
  let serverTime: number | null = null;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.error === "string") code = body.error;
    if (typeof body.server_time === "number") serverTime = body.server_time;
  } catch {
    // not JSON — status alone
  }
  return {
    kind: "error",
    status: res.status,
    code,
    message: `control plane returned HTTP ${res.status}${code ? ` (${code})` : ""}`,
    serverTime,
  };
}
