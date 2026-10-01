// Approvals and taint on the link. A gateway files a held write, claims it
// once a person approved it, and reports how it went; before a write or a
// secret-table read it checks its grant's taint, and before a read that
// returns untrusted content it records it. Pending approvals and taint live
// in the cloud, so every gateway instance sees the same ones.
//
// The answers a gateway acts on are signed with the bundle key: a decision
// when a person makes it, a claim and a taint answer for the nonce the
// gateway sent. A proxy between gateway and cloud can then neither approve
// a write nor report a tainted grant clean.

import { z } from "zod";
import { DatabaseIdSchema } from "./claims.ts";
import { ApprovalClassSchema, HoldCauseSchema } from "./rules.ts";

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** An approval's id: a plain token, safe in a URL and a message. */
export const ApprovalIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** Fresh for every signed answer the gateway asks for. */
export const NonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22,86}$/);

/** Filing carries the statement, so it has its own cap: the core's 1 MiB and the rest. */
export const APPROVAL_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

/** The longest statement that can be filed; the core refuses longer ones too. */
export const APPROVAL_SQL_MAX = 1_048_576;

/**
 * How long a request may wait, in minutes: pending for a decision, then
 * approved for its re-run. A gateway refuses a decision that claims to last
 * longer than `approved.max`, whatever the cloud's settings say.
 */
export const APPROVAL_WINDOWS = {
  pending: { min: 5, max: 24 * 60 },
  approved: { min: 1, max: 120 },
} as const;

export const APPROVAL_JWS_TYPE = "mp-approval";
export const CLAIM_JWS_TYPE = "mp-claim";
export const TAINT_JWS_TYPE = "mp-taint";

/**
 * Link features a gateway reports beyond the core's policy sections:
 * `approvals` (it files held writes), `taint` (it keeps taint in the
 * cloud, shared by every instance) and `audit` (it pushes its audit log).
 */
export const LINK_FEATURES = {
  approvals: "approvals",
  taint: "taint",
  audit: "audit",
} as const;

export const approvalsPath = "/approvals";
export function approvalPath(id: string): string {
  return `/approvals/${encodeURIComponent(id)}`;
}
export const taintPath = "/taint";
export function grantTaintPath(grantId: string): string {
  return `/taint/${encodeURIComponent(grantId)}`;
}

/**
 * Where a request stands. `used`: claimed by a gateway, which ran it or
 * tried to. `canceled`: its grant ended.
 */
export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "canceled",
  "used",
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** The rows a held write would change, as the gateway counted them. */
export const PreviewCountSchema = z.strictObject({
  /** Null when counting failed. */
  count: z.number().int().nonnegative().nullable(),
  /** False when the write may change fewer rows (ON CONFLICT). */
  exact: z.boolean(),
  /** SQLSTATE or Node error code of a failed count. */
  code: z.string().max(32).nullable(),
});
export type PreviewCount = z.infer<typeof PreviewCountSchema>;

// ── filing ──────────────────────────────────────────────────────────────────

export const FileApprovalRequestSchema = z.strictObject({
  /** The attempt that filed it, in the gateway's audit log. */
  query_id: z.string().min(1).max(64),
  database: DatabaseIdSchema,
  /** The raw statement: the approval binds these exact bytes. */
  sql: z.string().min(1).max(APPROVAL_SQL_MAX),
  intent: z.string().max(2000),
  grant_id: z.string().min(1).max(128),
  sub: z.string().min(1).max(256),
  client_id: z.string().min(1).max(256),
  /** The core's key; the cloud computes it again and refuses a mismatch. */
  approval_key: Sha256HexSchema,
  class: ApprovalClassSchema,
  cause: HoldCauseSchema,
  tables: z.array(z.string().min(1).max(256)).max(256),
  /** Null when the write can't be counted (a volatile call, a schema change). */
  preview: PreviewCountSchema.nullable(),
});
export type FileApprovalRequest = z.infer<typeof FileApprovalRequestSchema>;

/**
 * The request that governs a filed statement: an open one, or a new one.
 * Statuses are read leniently, so a newer cloud can add one; only
 * `approved` leads to a claim.
 */
export const FiledApprovalSchema = z.object({
  id: ApprovalIdSchema,
  status: z.string().min(1).max(32),
  /** True when this filing opened it. */
  created: z.boolean(),
  /** ISO 8601. */
  filed_at: z.string().min(1),
  /** ISO 8601: when it stops being decidable, or claimable once approved. */
  expires_at: z.string().min(1),
  /** Informational: the gateway builds the review URL from its own cloud URL. */
  review_url: z.string().optional(),
  preview: PreviewCountSchema.loose().nullable().default(null),
  decided_by: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
  /** The request this one replaces, which expired, was used or canceled. */
  replaces: ApprovalIdSchema.nullable().catch(null).default(null),
});
export type FiledApproval = z.infer<typeof FiledApprovalSchema>;
export type FiledApprovalInput = z.input<typeof FiledApprovalSchema>;

// ── claiming ────────────────────────────────────────────────────────────────

export const ClaimRequestSchema = z.strictObject({
  approval_key: Sha256HexSchema,
  grant_id: z.string().min(1).max(128),
  /** The re-run that claims it. */
  query_id: z.string().min(1).max(64),
  nonce: NonceSchema,
});
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>;

export const ClaimAnswerSchema = z.object({
  /** A compact JWS (`typ: mp-approval`), signed when the person approved. */
  decision: z.string().min(1),
  /** A compact JWS (`typ: mp-claim`), signed for this claim's nonce. */
  claim: z.string().min(1),
});

/** Why a claim was refused (409). Read leniently, like every answer. */
export const ClaimRefusalSchema = z.object({
  status: z.string().min(1).max(32),
});

/** A person's approval, as signed when they made it. */
export const DecisionPayloadSchema = z.object({
  v: z.literal(1),
  iss: z.string().min(1),
  project_id: z.string().min(1),
  approval_id: z.string().min(1),
  database: z.string().min(1),
  approval_key: z.string().min(1),
  grant_id: z.string().min(1),
  /** The count the person saw; null when there was none. */
  preview: z
    .object({ count: z.number().int().nonnegative(), exact: z.boolean() })
    .nullable(),
  /** Seconds since the epoch: the approval can't be claimed after this. */
  expires_at: z.number().int(),
  /** The person's name, as the agent is told. */
  decided_by: z.string(),
  iat: z.number().int(),
});
export type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;

export const ClaimPayloadSchema = z.object({
  v: z.literal(1),
  iss: z.string().min(1),
  project_id: z.string().min(1),
  approval_id: z.string().min(1),
  nonce: z.string().min(1),
  iat: z.number().int(),
});
export type ClaimPayload = z.infer<typeof ClaimPayloadSchema>;

// ── the outcome, and where a request stands ────────────────────────────────

export const ApprovalOutcomeSchema = z.strictObject({
  query_id: z.string().min(1).max(64),
  executed: z.boolean(),
  /** Rows the write changed; null when it failed before Postgres counted. */
  row_count: z.number().int().nonnegative().nullable(),
  /** SQLSTATE, `row_count` for a mismatch, or another short code. */
  code: z.string().max(32).nullable(),
});
export type ApprovalOutcome = z.infer<typeof ApprovalOutcomeSchema>;

/** A request as `check_approval` reports it, to the grant that filed it only. */
export const ApprovalStateSchema = z.object({
  id: ApprovalIdSchema,
  /** One of ApprovalStatus, or a status a newer cloud added. */
  status: z.string().min(1).max(32),
  database: z.string(),
  expires_at: z.string(),
  /** Informational: the gateway builds the review URL from its own cloud URL. */
  review_url: z.string().optional(),
  preview: PreviewCountSchema.loose().nullable().default(null),
  decided_by: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
  outcome: z
    .object({
      executed: z.boolean(),
      row_count: z.number().int().nullable(),
      code: z.string().nullable(),
    })
    .nullable()
    .default(null),
});
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;
export type ApprovalStateInput = z.input<typeof ApprovalStateSchema>;

// ── taint ───────────────────────────────────────────────────────────────────

export const TaintSourceSchema = z.strictObject({
  /** `schema.table`. */
  table: z.string().min(1).max(256),
  column: z.string().min(1).max(128),
});

/** Sent before a statement whose result carries untrusted content runs. */
export const TaintReportSchema = z.strictObject({
  grant_id: z.string().min(1).max(128),
  source: TaintSourceSchema,
  query_id: z.string().min(1).max(64),
  nonce: NonceSchema,
});
export type TaintReport = z.infer<typeof TaintReportSchema>;

export const TaintAnswerSchema = z.object({
  /** A compact JWS (`typ: mp-taint`) for the request's nonce. */
  proof: z.string().min(1),
});

/** A grant's taint, as the cloud holds it, for one nonce. */
export const TaintPayloadSchema = z.object({
  v: z.literal(1),
  iss: z.string().min(1),
  project_id: z.string().min(1),
  grant_id: z.string().min(1),
  tainted: z.boolean(),
  /** Seconds since the epoch; null when clean. */
  since: z.number().int().nullable(),
  source: z.object({ table: z.string(), column: z.string() }).nullable(),
  nonce: z.string().min(1),
  iat: z.number().int(),
});
export type TaintPayload = z.infer<typeof TaintPayloadSchema>;

// ── the recount command ─────────────────────────────────────────────────────

export const CountPreviewPayloadSchema = z.object({
  approval_id: ApprovalIdSchema,
});

/**
 * A recount of a held write this gateway filed. `not_held`: under the
 * current policy and taint it would be allowed or denied. `unknown`: the
 * statement isn't in this gateway's audit log.
 */
export const CountPreviewResultSchema = z.strictObject({
  status: z.enum(["counted", "not_held", "unknown", "failed"]),
  /** Null when there is nothing to count or counting failed. */
  count: z.number().int().nonnegative().nullable(),
  exact: z.boolean().nullable(),
  code: z.string().max(32).nullable(),
});
export type CountPreviewResult = z.infer<typeof CountPreviewResultSchema>;
