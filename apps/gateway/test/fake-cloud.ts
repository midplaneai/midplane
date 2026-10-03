// A stand-in for Midplane Cloud's side of the link, so the gateway's linked
// mode is tested within oss/ alone: enrollment with a pinned signing key,
// client_credentials with private_key_jwt, the long poll, signed bundles,
// commands, catalog uploads, held writes, taint and the audit push. It
// never opens a connection to the gateway, and it keeps every body the
// gateway sends, so tests can scan them.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { approvalKey, unredactedDefinitions } from "@midplane/core";
import {
  APPROVAL_JWS_TYPE,
  type ApprovalOutcome,
  ApprovalOutcomeSchema,
  type ApprovalStatus,
  AUDIT_ACK_JWS_TYPE,
  AuditBatchSchema,
  type AuditRecord,
  BUNDLE_JWS_TYPE,
  CatalogSnapshotSchema,
  CLAIM_JWS_TYPE,
  ClaimRequestSchema,
  type CommandResult,
  CommandResultSchema,
  EnrollRequestSchema,
  type FileApprovalRequest,
  FileApprovalRequestSchema,
  FRESHNESS_JWS_TYPE,
  type GatewayStatus,
  GatewayStatusSchema,
  IDENTITY_JWS_TYPE,
  LINK_API_PREFIX,
  NonceSchema,
  TAINT_JWS_TYPE,
  TaintReportSchema,
} from "@midplane/protocol";
import { Hono } from "hono";
import {
  CompactSign,
  calculateJwkThumbprint,
  importJWK,
  type JWK,
  jwtVerify,
} from "jose";
import { generateSigningKey, mintToken } from "../src/auth.ts";

/** A held write as the stand-in keeps it. */
export interface FakeApproval {
  id: string;
  request: FileApprovalRequest;
  status: ApprovalStatus;
  filedAt: Date;
  expiresAt: Date;
  decision: string | null;
  decidedBy: string | null;
  note: string | null;
  claims: number;
  outcome: ApprovalOutcome | null;
}

/** How the stand-in answers taint calls. */
export type TaintMode =
  | "ok"
  /** 503 to every taint call. */
  | "fail"
  /** Proofs signed with another key. */
  | "forge"
  /** Proofs for another nonce. */
  | "replay";

/** How the stand-in signs audit acks, when not as the cloud would. */
export type AuditAckForgery =
  /** Signed with another key. */
  | "forge"
  /** For another nonce. */
  | "replay"
  /** No proof at all, as an older answer had. */
  | "none"
  /** Signed, naming another hash than the stored event's at `acked`. */
  | "hash"
  /** Signed, naming a conflict at the batch's last record under its own hash. */
  | "conflict";

export interface FakeCloud {
  url: string;
  projectId: string;
  /** The project's databases: enrollment adds those a gateway names. */
  databases: Set<string>;
  /** The enrolled gateway's id, once it has enrolled. */
  gatewayId: string | null;
  /**
   * The resources registered for the gateway, which every published bundle
   * lists under its id: those it enrolled with, until changed here.
   */
  registered: string[];
  /**
   * A fresh single-use enrollment token pinning this cloud's signing key,
   * or `pin` instead (what a TLS-inspecting proxy's victim would hold).
   */
  enrollmentToken(o?: { pin?: Buffer }): string;
  /** Sign a payload as a bundle (or with `typ`), with this cloud's key or another. */
  sign(
    payload: unknown,
    o?: { privateJwk?: JWK; typ?: string },
  ): Promise<string>;
  /** Publish the next version; `extra` overrides or adds payload fields. */
  publish(
    databases: Record<string, unknown>,
    extra?: Record<string, unknown>,
  ): Promise<{ version: number; jws: string }>;
  /** Hand the gateway exactly this JWS on its next sync. */
  deliver(jws: string): void;
  /** Leave out the freshness proof from the next answer carrying a bundle. */
  stripFreshness(): void;
  /** Answer the next `n` command results with a 503. */
  failResults(n: number): void;
  command(kind: string, payload?: unknown): string;
  results: Map<string, CommandResult>;
  statuses: GatewayStatus[];
  /** Every POST body the gateway sent, in order. */
  bodies: { path: string; body: string }[];
  /** The catalog stored per database: the upload body and its hash. */
  catalogs: Map<string, { body: string; sha256: string }>;
  /** Every catalog upload, stored (204) or refused. */
  uploads: { database: string; sha256: string; status: number }[];
  /** Refuse catalog uploads with this status from now on; null accepts them. */
  refuseCatalogs(status: 400 | 404 | 413 | null): void;
  /** Answer syncs with these catalog hashes instead of the stored ones. */
  echoCatalogs(hashes: Record<string, string> | null): void;
  /** Agent tokens, signed with the key the bundles carry. */
  agentToken(o: {
    audience: string;
    databases?: Record<string, "read" | "write">;
    jti?: string;
    grantId?: string;
    sub?: string;
  }): Promise<string>;
  /** Held writes, by id, in filing order. */
  approvals: Map<string, FakeApproval>;
  /** Approve a pending request, signing the decision (with another key to forge it). */
  approve(
    id: string,
    o?: {
      preview?: { count: number; exact: boolean } | null;
      privateJwk?: JWK;
      /** Sign a decision for another statement or grant, or another deadline. */
      tamper?: Partial<{
        approval_key: string;
        grant_id: string;
        expires_at: number;
      }>;
    },
  ): Promise<void>;
  deny(id: string, note?: string): void;
  /** Sign claims with another key, or for another nonce, from now on. */
  forgeClaims(mode: "forge" | "replay" | null): void;
  /** Answer filings and states with this review URL instead of its own. */
  reviewUrlOverride(url: string | null): void;
  /** Refuse filings with this status and description, from now on. */
  refuseFiling(
    refusal: { status: 400 | 403 | 429; description: string } | null,
  ): void;
  /** Sign claims as if the cloud's clock ran this many seconds ahead. */
  claimClock(aheadSeconds: number): void;
  /** Tainted grants and where their taint came from. */
  taints: Map<
    string,
    { since: Date; source: { table: string; column: string } }
  >;
  taintMode(mode: TaintMode): void;
  /** Taint checks answered, per grant. */
  taintChecks: string[];
  /**
   * Audit records stored, per instance, by sequence: a resent one replaces
   * nothing, and none is stored from a batch's first conflict on.
   */
  audit: Map<string, Map<number, AuditRecord>>;
  /** Every audit batch answered, with its status. */
  auditBatches: { instance: string; seqs: number[]; status: number }[];
  /** Answer audit batches with this status from now on; null stores them. */
  refuseAudit(status: 400 | 404 | 500 | null): void;
  /**
   * Ack this much less than the batch's last sequence, as a cloud that
   * stored only part of it would. (A negative offset acks past the batch,
   * which the gateway refuses.)
   */
  auditAckOffset(offset: number): void;
  /** Store audit batches but forge their acks from now on; null signs them. */
  forgeAuditAck(mode: AuditAckForgery | null): void;
  /**
   * Answer every batch from now on as if another event were stored at its
   * first sequence: store none of it, and sign that conflict.
   */
  conflictAudit(on: boolean): void;
  /** Answer the next `n` audit batches 429, as while another replica's is stored. */
  slowDownAudit(n: number): void;
  /** Refuse the gateway's credentials from now on, as a revocation does. */
  revoke(): void;
  /** Stop answering (the cloud is down) and start again on the same port. */
  down(): Promise<void>;
  up(): Promise<void>;
  close(): Promise<void>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A nonce that differs from `n`, as a replayed answer's would. */
const otherNonce = (n: string) =>
  `${n.startsWith("x") ? "y" : "x"}${n.slice(1)}`;

export async function startFakeCloud(
  options: { waitMs?: number; databases?: string[] } = {},
): Promise<FakeCloud> {
  const waitMs = options.waitMs ?? 300;
  const projectId = `prj_${randomBytes(6).toString("hex")}`;
  const projectDatabases = new Set(options.databases ?? []);
  const signing = await generateSigningKey();
  const signingKey = await importJWK(signing.privateJwk, "EdDSA");
  const pin = Buffer.from(
    await calculateJwkThumbprint(
      { kty: "OKP", crv: "Ed25519", x: signing.publicJwk.x as string },
      "sha256",
    ),
    "base64url",
  );
  const agent = await generateSigningKey();
  const agentPublic = { ...agent.publicJwk, kid: "agent-1" };
  const agentPrivate = { ...agent.privateJwk, kid: "agent-1" };

  const tokens = new Set<string>();
  let client: { id: string; key: JWK } | null = null;
  let gatewayId: string | null = null;
  let registered: string[] = [];
  let revoked = false;
  const accessTokens = new Set<string>();
  let latest: { version: number; jws: string } | null = null;
  const deliveries: string[] = [];
  const commands: { id: string; kind: string; payload: unknown }[] = [];
  const results = new Map<string, CommandResult>();
  const statuses: GatewayStatus[] = [];
  const bodies: { path: string; body: string }[] = [];
  const catalogs = new Map<string, { body: string; sha256: string }>();
  const uploads: { database: string; sha256: string; status: number }[] = [];
  let refusing: 400 | 404 | 413 | null = null;
  let echo: Record<string, string> | null = null;
  let wake: (() => void) | null = null;
  let strip = false;
  let failing = 0;
  const poke = () => wake?.();
  const approvals = new Map<string, FakeApproval>();
  let claimTamper: "forge" | "replay" | null = null;
  let reviewOverride: string | null = null;
  let filingRefusal: { status: 400 | 403 | 429; description: string } | null =
    null;
  let claimAheadS = 0;
  const taints = new Map<
    string,
    { since: Date; source: { table: string; column: string } }
  >();
  let taintMode: TaintMode = "ok";
  const taintChecks: string[] = [];
  const audit = new Map<string, Map<number, AuditRecord>>();
  const auditBatches: { instance: string; seqs: number[]; status: number }[] =
    [];
  let auditRefusal: 400 | 404 | 500 | null = null;
  let ackOffset = 0;
  let ackForgery: AuditAckForgery | null = null;
  let conflicting = false;
  let slowDowns = 0;
  const foreign = await generateSigningKey();

  let url = "";
  const sign = async (
    payload: unknown,
    o: { privateJwk?: JWK; typ?: string } = {},
  ) =>
    new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
      .setProtectedHeader({ alg: "EdDSA", typ: o.typ ?? BUNDLE_JWS_TYPE })
      .sign(o.privateJwk ? await importJWK(o.privateJwk, "EdDSA") : signingKey);

  const app = new Hono();
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      bodies.push({ path: c.req.path, body: await c.req.raw.clone().text() });
    }
    await next();
  });
  app.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({ issuer: url, token_endpoint: `${url}/oauth2/token` }),
  );

  app.post(`${LINK_API_PREFIX}/enroll`, async (c) => {
    const body = EnrollRequestSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: "invalid_request" }, 400);
    const hash = sha256(body.data.token);
    if (!tokens.delete(hash)) {
      return c.json(
        { error: "invalid_token", error_description: "unknown token" },
        401,
      );
    }
    client = { id: `gwc_${randomUUID()}`, key: body.data.public_key };
    gatewayId = `gw_${randomUUID()}`;
    registered = [...body.data.resources];
    const added = (body.data.databases ?? []).filter(
      (d) => !projectDatabases.has(d),
    );
    for (const d of added) projectDatabases.add(d);
    const identity = await sign(
      {
        v: 1,
        iss: url,
        project_id: projectId,
        gateway_id: gatewayId,
        client_id: client.id,
        resource: body.data.resources[0],
        key_thumbprint: await calculateJwkThumbprint(body.data.public_key),
        bundle_version: latest?.version ?? 0,
        iat: Math.floor(Date.now() / 1000),
      },
      { typ: IDENTITY_JWS_TYPE },
    );
    return c.json({
      signing_key: signing.publicJwk,
      identity,
      project_name: "Test project",
      databases_added: added,
    });
  });

  app.post("/oauth2/token", async (c) => {
    const form = new URLSearchParams(await c.req.text());
    if (!client || revoked) {
      return c.json(
        { error: "invalid_client", error_description: "client is disabled" },
        401,
      );
    }
    try {
      await jwtVerify(
        form.get("client_assertion") ?? "",
        await importJWK(client.key, "EdDSA"),
        { issuer: client.id, subject: client.id, audience: url },
      );
    } catch {
      return c.json({ error: "invalid_client" }, 401);
    }
    if (
      form.get("grant_type") !== "client_credentials" ||
      form.get("resource") !== `${url}${LINK_API_PREFIX}`
    ) {
      return c.json({ error: "invalid_request" }, 400);
    }
    const token = randomBytes(16).toString("hex");
    accessTokens.add(token);
    return c.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: 300,
    });
  });

  const authed = (auth: string | undefined) =>
    !revoked && accessTokens.has((auth ?? "").replace(/^Bearer /, ""));

  app.post(`${LINK_API_PREFIX}/sync`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    const status = GatewayStatusSchema.parse(await c.req.json());
    statuses.push(status);
    const answer = async () => {
      const out: {
        bundle?: string;
        freshness?: string;
        commands: typeof commands;
      } = {
        commands: commands.filter((cmd) => !results.has(cmd.id)),
      };
      const next = deliveries.shift();
      if (next) out.bundle = next;
      else if (
        latest &&
        (status.bundle_version === null ||
          status.bundle_version < latest.version)
      ) {
        out.bundle = latest.jws;
      }
      if (!out.bundle && out.commands.length === 0) return null;
      if (out.bundle && strip) {
        strip = false;
        return out;
      }
      return { ...out, freshness: await freshness() };
    };
    const freshness = () =>
      sign(
        {
          v: 1,
          iss: url,
          project_id: projectId,
          version: latest?.version ?? 0,
          nonce: status.nonce,
          iat: Math.floor(Date.now() / 1000),
        },
        { typ: FRESHNESS_JWS_TYPE },
      );
    let out = await answer();
    if (!out) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
      out = (await answer()) ?? { commands: [] };
    }
    const held =
      echo ??
      Object.fromEntries([...catalogs].map(([id, cat]) => [id, cat.sha256]));
    return c.json({ ...out, catalogs: held });
  });

  app.post(`${LINK_API_PREFIX}/catalogs/:database`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    const database = c.req.param("database");
    const text = await c.req.text();
    const hash = sha256(text);
    const answer = (status: 204 | 400 | 404 | 413) => {
      uploads.push({ database, sha256: hash, status });
      return c.body(null, status);
    };
    if (refusing) return answer(refusing);
    let parsed: ReturnType<typeof CatalogSnapshotSchema.safeParse>;
    try {
      parsed = CatalogSnapshotSchema.safeParse(JSON.parse(text));
    } catch {
      return answer(400);
    }
    if (!parsed.success || unredactedDefinitions(parsed.data).length > 0) {
      return answer(400);
    }
    catalogs.set(database, { body: text, sha256: hash });
    return answer(204);
  });

  app.post(`${LINK_API_PREFIX}/commands/:id`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    if (failing > 0) {
      failing--;
      return c.body(null, 503);
    }
    results.set(
      c.req.param("id"),
      CommandResultSchema.parse(await c.req.json()),
    );
    return c.body(null, 204);
  });

  const now = () => Math.floor(Date.now() / 1000);
  const oauth = (status: 400 | 403 | 404 | 409 | 429, description: string) =>
    Response.json(
      { error: "invalid_request", error_description: description },
      { status },
    );

  // ── taint ──────────────────────────────────────────────────────────────
  const taintProof = async (grantId: string, nonce: string) => {
    const t = taints.get(grantId);
    return sign(
      {
        v: 1,
        iss: url,
        project_id: projectId,
        grant_id: grantId,
        tainted: t !== undefined,
        since: t ? Math.floor(t.since.getTime() / 1000) : null,
        source: t?.source ?? null,
        nonce: taintMode === "replay" ? otherNonce(nonce) : nonce,
        iat: now(),
      },
      {
        typ: TAINT_JWS_TYPE,
        ...(taintMode === "forge" ? { privateJwk: foreign.privateJwk } : {}),
      },
    );
  };
  app.get(`${LINK_API_PREFIX}/taint/:grant`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    if (taintMode === "fail") return c.body(null, 503);
    const nonce = NonceSchema.safeParse(c.req.query("nonce"));
    if (!nonce.success) return oauth(400, "a nonce is required");
    taintChecks.push(c.req.param("grant"));
    return c.json({
      proof: await taintProof(c.req.param("grant"), nonce.data),
    });
  });
  app.post(`${LINK_API_PREFIX}/taint`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    if (taintMode === "fail") return c.body(null, 503);
    const body = TaintReportSchema.safeParse(await c.req.json());
    if (!body.success) return oauth(400, "malformed taint report");
    if (!taints.has(body.data.grant_id)) {
      taints.set(body.data.grant_id, {
        since: new Date(),
        source: body.data.source,
      });
    }
    return c.json({
      proof: await taintProof(body.data.grant_id, body.data.nonce),
    });
  });

  // ── approvals ──────────────────────────────────────────────────────────
  const live = (a: FakeApproval) =>
    (a.status === "pending" || (a.status === "approved" && a.claims === 0)) &&
    a.expiresAt.getTime() > Date.now();
  const filed = (
    a: FakeApproval,
    created: boolean,
    replaces: string | null,
  ) => ({
    id: a.id,
    status: a.status,
    created,
    filed_at: a.filedAt.toISOString(),
    expires_at: a.expiresAt.toISOString(),
    review_url: reviewOverride ?? `${url}/approvals/${a.id}`,
    preview: a.request.preview,
    decided_by: a.decidedBy,
    note: a.note,
    replaces,
  });
  app.post(`${LINK_API_PREFIX}/audit`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    const nonce = NonceSchema.safeParse(c.req.query("nonce"));
    // As the cloud must: hash the bytes received, before parsing them.
    const raw = Buffer.from(await c.req.arrayBuffer());
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      parsed = undefined;
    }
    const batch = AuditBatchSchema.safeParse(parsed);
    if (!nonce.success || !batch.success) {
      auditBatches.push({ instance: "?", seqs: [], status: 400 });
      return c.json({ error: "invalid_request" }, 400);
    }
    const { instance, records } = batch.data;
    const seqs = records.map((r) => r.seq);
    if (slowDowns > 0) {
      slowDowns--;
      auditBatches.push({ instance, seqs, status: 429 });
      return c.json({ error: "slow_down" }, 429);
    }
    if (auditRefusal) {
      auditBatches.push({ instance, seqs, status: auditRefusal });
      return c.json({ error: "refused" }, auditRefusal);
    }
    // As the cloud stores a batch: in order, up to the first record it
    // holds under another hash, and nothing from there on.
    const stored = audit.get(instance) ?? new Map<number, AuditRecord>();
    let conflict: { seq: number; hash: string } | null = null;
    for (const r of records) {
      const held = conflicting
        ? sha256(`another event ${r.seq}`)
        : stored.get(r.seq)?.hash;
      if (held !== undefined && held !== r.hash) {
        conflict = { seq: r.seq, hash: held };
        break;
      }
      stored.set(r.seq, stored.get(r.seq) ?? r);
    }
    audit.set(instance, stored);
    auditBatches.push({ instance, seqs, status: 200 });
    const last = conflict ? conflict.seq - 1 : (seqs.at(-1) ?? 0);
    let acked = Math.max(0, last - ackOffset);
    if (ackForgery === "none") return c.json({ acked });
    let hash = stored.get(acked)?.hash ?? null;
    if (ackForgery === "hash") hash = sha256(`another event ${acked}`);
    if (ackForgery === "conflict") {
      const at = records.at(-1) as AuditRecord;
      conflict = { seq: at.seq, hash: at.hash };
      acked = at.seq - 1;
      hash = stored.get(acked)?.hash ?? null;
    }
    // As the cloud signs it: the hash it holds at `acked` and the first
    // conflict, for this nonce and the body it received.
    const proof = await sign(
      {
        v: 1,
        iss: url,
        project_id: projectId,
        gateway_id: gatewayId,
        instance,
        acked,
        hash,
        conflict,
        body_sha256: createHash("sha256").update(raw).digest("hex"),
        nonce: ackForgery === "replay" ? otherNonce(nonce.data) : nonce.data,
        iat: now(),
      },
      {
        typ: AUDIT_ACK_JWS_TYPE,
        ...(ackForgery === "forge" ? { privateJwk: foreign.privateJwk } : {}),
      },
    );
    return c.json({ acked, proof });
  });

  app.post(`${LINK_API_PREFIX}/approvals`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    const body = FileApprovalRequestSchema.safeParse(await c.req.json());
    if (!body.success) return oauth(400, "malformed approval request");
    if (filingRefusal)
      return oauth(filingRefusal.status, filingRefusal.description);
    const r = body.data;
    const key = approvalKey({
      databaseId: r.database,
      sql: r.sql,
      intent: r.intent,
      grantId: r.grant_id,
    });
    if (key !== r.approval_key)
      return oauth(400, "the approval key doesn't match");
    const same = [...approvals.values()].filter(
      (a) =>
        a.request.approval_key === key && a.request.database === r.database,
    );
    const open = same.find(live);
    if (open) return c.json(filed(open, false, null));
    const latest = same.at(-1);
    if (latest?.status === "denied") return c.json(filed(latest, false, null));
    const a: FakeApproval = {
      id: `apv_${randomUUID()}`,
      request: r,
      status: "pending",
      filedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      decision: null,
      decidedBy: null,
      note: null,
      claims: 0,
      outcome: null,
    };
    approvals.set(a.id, a);
    return c.json(filed(a, true, latest?.id ?? null));
  });
  app.post(`${LINK_API_PREFIX}/approvals/:id/claim`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    const body = ClaimRequestSchema.safeParse(await c.req.json());
    if (!body.success) return oauth(400, "malformed claim");
    const a = approvals.get(c.req.param("id"));
    if (
      !a ||
      a.request.approval_key !== body.data.approval_key ||
      a.request.grant_id !== body.data.grant_id
    ) {
      return oauth(404, "no such approval");
    }
    const status: ApprovalStatus =
      a.status === "approved" && a.claims > 0
        ? "used"
        : a.expiresAt.getTime() <= Date.now()
          ? "expired"
          : a.status;
    if (status !== "approved" || !a.decision) return c.json({ status }, 409);
    a.claims++;
    a.status = "used";
    const claim = await sign(
      {
        v: 1,
        iss: url,
        project_id: projectId,
        approval_id: a.id,
        nonce:
          claimTamper === "replay"
            ? otherNonce(body.data.nonce)
            : body.data.nonce,
        iat: now() + claimAheadS,
      },
      {
        typ: CLAIM_JWS_TYPE,
        ...(claimTamper === "forge" ? { privateJwk: foreign.privateJwk } : {}),
      },
    );
    return c.json({ decision: a.decision, claim });
  });
  app.post(`${LINK_API_PREFIX}/approvals/:id/outcome`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    const a = approvals.get(c.req.param("id"));
    if (!a) return oauth(404, "no such approval");
    a.outcome = ApprovalOutcomeSchema.parse(await c.req.json());
    return c.body(null, 204);
  });
  app.get(`${LINK_API_PREFIX}/approvals/:id`, async (c) => {
    if (!authed(c.req.header("authorization"))) return c.body(null, 401);
    const a = approvals.get(c.req.param("id"));
    if (!a || a.request.grant_id !== c.req.query("grant_id"))
      return oauth(404, "no such approval");
    return c.json({
      id: a.id,
      status:
        a.status === "pending" && a.expiresAt.getTime() <= Date.now()
          ? "expired"
          : a.status,
      database: a.request.database,
      expires_at: a.expiresAt.toISOString(),
      review_url: reviewOverride ?? `${url}/approvals/${a.id}`,
      preview: a.request.preview,
      decided_by: a.decidedBy,
      note: a.note,
      outcome: a.outcome
        ? {
            executed: a.outcome.executed,
            row_count: a.outcome.row_count,
            code: a.outcome.code,
          }
        : null,
    });
  });

  let server: ReturnType<typeof serve> | null = null;
  let port = 0;
  const up = () =>
    new Promise<void>((resolve) => {
      server = serve(
        { fetch: app.fetch, hostname: "127.0.0.1", port },
        (info: AddressInfo) => {
          port = info.port;
          url = `http://127.0.0.1:${port}`;
          resolve();
        },
      );
    });
  const down = () =>
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
      server = null;
    });
  await up();

  let version = 0;
  return {
    get url() {
      return url;
    },
    projectId,
    databases: projectDatabases,
    get gatewayId() {
      return gatewayId;
    },
    get registered() {
      return registered;
    },
    set registered(resources: string[]) {
      registered = resources;
    },
    enrollmentToken(o = {}) {
      const token = `mpe1_${Buffer.concat([o.pin ?? pin, randomBytes(32)]).toString("base64url")}`;
      tokens.add(sha256(token));
      return token;
    },
    sign,
    async publish(databases, extra = {}) {
      version = typeof extra.version === "number" ? extra.version : version + 1;
      const jws = await sign({
        v: 1,
        iss: url,
        project_id: projectId,
        version,
        iat: Math.floor(Date.now() / 1000),
        paused: false,
        crit: [],
        jwks: { keys: [agentPublic] },
        revoked_tokens: [],
        databases,
        ...(gatewayId
          ? { gateways: { [gatewayId]: { resources: registered } } }
          : {}),
        ...extra,
      });
      latest = { version, jws };
      poke();
      return latest;
    },
    deliver(jws) {
      deliveries.push(jws);
      poke();
    },
    stripFreshness() {
      strip = true;
    },
    failResults(n) {
      failing = n;
    },
    command(kind, payload = {}) {
      const id = `cmd_${randomUUID()}`;
      commands.push({ id, kind, payload });
      poke();
      return id;
    },
    results,
    statuses,
    bodies,
    catalogs,
    uploads,
    refuseCatalogs(status) {
      refusing = status;
    },
    echoCatalogs(hashes) {
      echo = hashes;
    },
    agentToken: (o) =>
      mintToken({
        privateJwk: agentPrivate,
        issuer: url,
        audience: o.audience,
        project: projectId,
        sub: o.sub ?? "person-1",
        clientId: "agent-client",
        grantId: o.grantId ?? "grant-1",
        databases: o.databases ?? { main: "write" },
        ttlSeconds: 300,
        ...(o.jti ? { jti: o.jti } : {}),
      }),
    approvals,
    async approve(id, o = {}) {
      const a = approvals.get(id);
      if (!a) throw new Error(`no approval ${id}`);
      const p = a.request.preview;
      const preview =
        o.preview !== undefined
          ? o.preview
          : p && p.count !== null
            ? { count: p.count, exact: p.exact }
            : null;
      a.expiresAt = new Date(Date.now() + 15 * 60 * 1000);
      a.decidedBy = "Pat Approver";
      a.decision = await sign(
        {
          v: 1,
          iss: url,
          project_id: projectId,
          approval_id: a.id,
          database: a.request.database,
          approval_key: a.request.approval_key,
          grant_id: a.request.grant_id,
          preview,
          expires_at: Math.floor(a.expiresAt.getTime() / 1000),
          decided_by: a.decidedBy,
          iat: now(),
          ...o.tamper,
        },
        {
          typ: APPROVAL_JWS_TYPE,
          ...(o.privateJwk ? { privateJwk: o.privateJwk } : {}),
        },
      );
      a.status = "approved";
    },
    deny(id, note) {
      const a = approvals.get(id);
      if (!a) throw new Error(`no approval ${id}`);
      a.status = "denied";
      a.decidedBy = "Pat Approver";
      a.note = note ?? null;
    },
    forgeClaims(mode) {
      claimTamper = mode;
    },
    reviewUrlOverride(u) {
      reviewOverride = u;
    },
    refuseFiling(refusal) {
      filingRefusal = refusal;
    },
    claimClock(aheadSeconds) {
      claimAheadS = aheadSeconds;
    },
    taints,
    taintMode(mode) {
      taintMode = mode;
    },
    taintChecks,
    audit,
    auditBatches,
    refuseAudit(status) {
      auditRefusal = status;
    },
    auditAckOffset(offset) {
      ackOffset = offset;
    },
    forgeAuditAck(mode) {
      ackForgery = mode;
    },
    conflictAudit(on) {
      conflicting = on;
    },
    slowDownAudit(n) {
      slowDowns = n;
    },
    revoke() {
      revoked = true;
    },
    down,
    up,
    close: down,
  };
}
