// The gateway's audit events. ATTEMPTED and DECIDED are durable before a
// statement runs; EXECUTED or FAILED follow. A held write records APPROVAL
// when it is filed and again when it is claimed, which is durable before
// the claimed write runs, and before a recount. Records carry SQL text and
// metadata, never result rows.
//
// A linked gateway pushes each event to the cloud as a record: a projection
// with no result values and no Postgres message, and the statement with its
// literals replaced, unless the database's switch sends it as written.
//
// The cloud's ack is signed with the bundle key for the nonce the gateway
// sent, names the hash it holds at the acked sequence, and the hash of the
// request body it received. The gateway marks events acked only on an ack
// that verifies for the very bytes it sent, so a proxy that answers without
// forwarding, or forwards only part of a batch, can't make it forget events
// the cloud never got.

import { z } from "zod";
import { ApprovalIdSchema, PreviewCountSchema } from "./approvals.ts";
import { DatabaseIdSchema } from "./claims.ts";
import { ApprovalClassSchema, RuleIdSchema } from "./rules.ts";

export const ApprovalStepSchema = z.enum([
  "filed",
  "claimed",
  "recount",
  "claim_failed",
]);
export type ApprovalStep = z.infer<typeof ApprovalStepSchema>;

const base = {
  query_id: z.string().min(1),
  /** ISO 8601. */
  at: z.string().min(1),
};

export const AuditEventSchema = z.discriminatedUnion("event", [
  z.strictObject({
    ...base,
    event: z.literal("ATTEMPTED"),
    database: z.string().min(1),
    sub: z.string().min(1),
    client_id: z.string().min(1),
    grant_id: z.string().min(1),
    sql: z.string(),
    intent: z.string(),
  }),
  z.strictObject({
    ...base,
    event: z.literal("DECIDED"),
    verdict: z.enum(["allow", "hold", "deny"]),
    rule: RuleIdSchema.nullable(),
    reason: z.string().nullable(),
    class: ApprovalClassSchema.nullable(),
    fingerprint: z.string().nullable(),
    tables: z.array(z.string()),
    taints: z.boolean(),
    /** A returned value passes through a mask. Absent from events written before 0.21. */
    masked: z.boolean().optional(),
    /** The bundle it was decided under; null in local mode. Absent from events written before 0.21. */
    policy_version: z.number().int().positive().nullable().optional(),
  }),
  z.strictObject({
    ...base,
    event: z.literal("APPROVAL"),
    approval_id: z.string().min(1),
    /**
     * Filed (or found); claimed, before the write runs; about to be counted
     * again, before the count runs; or a claim whose answer was lost or
     * didn't verify, so nothing ran.
     */
    step: ApprovalStepSchema,
    /** As the cloud answered: an ApprovalStatus, or one a newer cloud added. */
    status: z.string().min(1).max(32),
    preview: PreviewCountSchema.nullable(),
  }),
  z.strictObject({
    ...base,
    event: z.literal("EXECUTED"),
    row_count: z.number().int().nullable(),
    duration_ms: z.number().nonnegative(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    ...base,
    event: z.literal("FAILED"),
    sqlstate: z.string().nullable(),
    message: z.string(),
  }),
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ── the push ──────────────────────────────────────────────────────────────

/**
 * `POST <link prefix>/audit?nonce=<nonce>`: a batch of one audit file's
 * records, answered with an ack signed for the nonce.
 */
export const auditPath = "/audit";

export const AUDIT_ACK_JWS_TYPE = "mp-audit-ack";

/** A batch's body cap: records are capped well below it. */
export const AUDIT_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

/** The most records in one batch. */
export const AUDIT_BATCH_MAX = 200;

/**
 * Text caps in a record, in UTF-16 code units: a statement (redacted or as
 * written), an intent, a denial's reason. Longer text is cut and marked; the
 * gateway's own log and its export keep all of it.
 */
export const AUDIT_TEXT_MAX = {
  statement: 16 * 1024,
  intent: 4 * 1024,
  reason: 1024,
} as const;

/** The most tables a record lists. */
export const AUDIT_TABLES_MAX = 256;

/** The most statement kinds a record names. */
export const AUDIT_KINDS_MAX = 8;

/**
 * Caps on a record's other strings, in UTF-16 code units. The gateway cuts
 * its values to them, so one long name can't get a whole batch refused.
 */
export const AUDIT_FIELD_MAX = {
  queryId: 128,
  at: 64,
  /** A person (`sub`), an agent (`client_id`) or a grant. */
  principal: 256,
  /** A statement kind, e.g. `CopyStmt`. */
  kind: 64,
  /** A table, `schema.name`. */
  table: 256,
  sqlstate: 32,
} as const;

const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** An audit file's instance: random, made with the file. */
export const AuditInstanceSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{8,64}$/, "not an audit file instance id");

const record = {
  /** The event's sequence in its file. */
  seq: z.number().int().positive(),
  /**
   * The event's hash in the file's chain, keyed: HMAC-SHA256 under a secret
   * the file keeps, so the cloud can't test a guess at its text against it.
   */
  hash: Sha256HexSchema,
  query_id: z.string().min(1).max(AUDIT_FIELD_MAX.queryId),
  at: z.string().min(1).max(AUDIT_FIELD_MAX.at),
};

/** Why a statement went up with no text. */
export const WithheldTextSchema = z.enum(["parse", "kind", "check", "long"]);
export type WithheldText = z.infer<typeof WithheldTextSchema>;

/**
 * One event as the cloud may see it. Strict: a field this protocol doesn't
 * name (a row value, a Postgres message) is refused rather than stored.
 */
export const AuditRecordSchema = z.discriminatedUnion("event", [
  z.strictObject({
    ...record,
    event: z.literal("ATTEMPTED"),
    database: DatabaseIdSchema,
    sub: z.string().min(1).max(AUDIT_FIELD_MAX.principal),
    client_id: z.string().min(1).max(AUDIT_FIELD_MAX.principal),
    grant_id: z.string().min(1).max(AUDIT_FIELD_MAX.principal),
    /** The statement with every literal replaced; null when it had to go without text. */
    statement: z.string().max(AUDIT_TEXT_MAX.statement).nullable(),
    /** Why there is no text, when there isn't. */
    withheld: WithheldTextSchema.nullable(),
    /**
     * Each statement's kind, sent with text or without: `InsertStmt` for
     * `WITH … INSERT`, `CopyStmt`. Empty when it didn't parse.
     */
    kinds: z
      .array(z.string().min(1).max(AUDIT_FIELD_MAX.kind))
      .max(AUDIT_KINDS_MAX),
    /** As written, with the intent: only while the database's switch is on. */
    full: z
      .strictObject({
        sql: z.string().max(AUDIT_TEXT_MAX.statement),
        intent: z.string().max(AUDIT_TEXT_MAX.intent),
      })
      .nullable(),
    /** A statement or intent here was cut. */
    truncated: z.boolean(),
  }),
  z.strictObject({
    ...record,
    event: z.literal("DECIDED"),
    verdict: z.enum(["allow", "hold", "deny"]),
    rule: RuleIdSchema.nullable(),
    class: ApprovalClassSchema.nullable(),
    /** Never sent: libpg_query's fingerprint covers names, so it could confirm a guessed one. */
    fingerprint: z.null(),
    tables: z
      .array(z.string().min(1).max(AUDIT_FIELD_MAX.table))
      .max(AUDIT_TABLES_MAX),
    taints: z.boolean(),
    masked: z.boolean().nullable(),
    policy_version: z.number().int().positive().nullable(),
    /** The denial's reason in words: only while the database's switch is on. */
    reason: z.string().max(AUDIT_TEXT_MAX.reason).nullable(),
  }),
  z.strictObject({
    ...record,
    event: z.literal("APPROVAL"),
    approval_id: ApprovalIdSchema,
    step: ApprovalStepSchema,
    status: z.string().min(1).max(32),
    preview: PreviewCountSchema.nullable(),
  }),
  z.strictObject({
    ...record,
    event: z.literal("EXECUTED"),
    row_count: z.number().int().nullable(),
    duration_ms: z.number().nonnegative(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    ...record,
    event: z.literal("FAILED"),
    /** Postgres' code only: its message can quote a row. */
    sqlstate: z.string().max(AUDIT_FIELD_MAX.sqlstate).nullable(),
  }),
]);
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/** The body of `POST /audit`: one file's records, in sequence order. */
export const AuditBatchSchema = z
  .strictObject({
    instance: AuditInstanceSchema,
    records: z.array(AuditRecordSchema).min(1).max(AUDIT_BATCH_MAX),
  })
  .refine(
    (b) =>
      b.records.every(
        (r, i) => i === 0 || r.seq > (b.records[i - 1]?.seq ?? 0),
      ),
    "records must be in increasing sequence order",
  );
export type AuditBatch = z.infer<typeof AuditBatchSchema>;

/**
 * The answer: the highest sequence of the batch the cloud has stored, which
 * stops short of a record it holds under another hash.
 */
export const AuditAckSchema = z.object({
  acked: z.number().int().nonnegative(),
  /** A compact JWS (`typ: mp-audit-ack`) for the request's nonce. */
  proof: z.string().min(1),
});
export type AuditAck = z.infer<typeof AuditAckSchema>;

/** An audit file's ack, as the cloud stored the batch, for one nonce. */
export const AuditAckPayloadSchema = z.object({
  v: z.literal(1),
  iss: z.string().min(1),
  project_id: z.string().min(1),
  gateway_id: z.string().min(1),
  instance: z.string().min(1),
  acked: z.number().int().nonnegative(),
  /** The hash the cloud holds for event `acked`; null when it holds none there. */
  hash: Sha256HexSchema.nullable(),
  /**
   * The batch's first record the cloud already holds under another hash,
   * with the hash it holds: it stored nothing from there on, and `acked` is
   * below it. Null when there is none.
   */
  conflict: z
    .object({ seq: z.number().int().positive(), hash: Sha256HexSchema })
    .nullable(),
  /**
   * SHA-256 of the request body's bytes as the cloud received them, before
   * parsing: the ack covers that batch and no other.
   */
  body_sha256: Sha256HexSchema,
  nonce: z.string().min(1),
  iat: z.number().int(),
});
export type AuditAckPayload = z.infer<typeof AuditAckPayloadSchema>;

/**
 * The head of a gateway's audit file, in every sync's status: its newest
 * event's sequence and hash, keyed as a record's is (or the anchor's, when
 * every event was pruned), and how many events the cloud doesn't have yet.
 */
export const AuditHeadSchema = z.strictObject({
  instance: AuditInstanceSchema,
  seq: z.number().int().nonnegative(),
  hash: Sha256HexSchema,
  unacked: z.number().int().nonnegative(),
});
export type AuditHead = z.infer<typeof AuditHeadSchema>;

/** The hash before the first event of a file. */
export const AUDIT_GENESIS_HASH = "0".repeat(64);
