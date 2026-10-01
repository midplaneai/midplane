// What the audit push may carry: a projection of each event, strict, so a
// field the protocol doesn't name (a row, a Postgres message) can't ride
// along; and the bundle's switch, read leniently, so a field a gateway can't
// read leaves statements redacted.

import { describe, expect, it } from "vitest";
import {
  AUDIT_BATCH_MAX,
  AUDIT_TEXT_MAX,
  AuditBatchSchema,
  AuditEventSchema,
  type AuditRecord,
  BundlePayloadSchema,
  GatewayStatusSchema,
} from "../src/index.ts";

const HASH = "a".repeat(64);

const attempted: AuditRecord = {
  seq: 1,
  hash: HASH,
  query_id: "q-1",
  at: "2026-10-01T12:00:00.000Z",
  event: "ATTEMPTED",
  database: "main",
  sub: "user-1",
  client_id: "client-1",
  grant_id: "grant-1",
  statement: "SELECT email FROM customers WHERE id = $1",
  withheld: null,
  kinds: [],
  full: null,
  truncated: false,
};
const failed: AuditRecord = {
  seq: 2,
  hash: HASH,
  query_id: "q-1",
  at: "2026-10-01T12:00:00.010Z",
  event: "FAILED",
  sqlstate: "22P02",
};

const batch = (records: unknown[]) =>
  AuditBatchSchema.safeParse({ instance: "6f1c0b9e-instance", records });

describe("AuditBatchSchema", () => {
  it("takes a batch of records in sequence order", () => {
    expect(batch([attempted, failed]).success).toBe(true);
  });

  it("refuses a field the protocol doesn't name: a Postgres message, a row", () => {
    expect(
      batch([attempted, { ...failed, message: 'invalid input: "jane"' }])
        .success,
    ).toBe(false);
    expect(batch([{ ...attempted, rows: [["jane@acme.com"]] }]).success).toBe(
      false,
    );
    expect(
      batch([{ ...attempted, full: { sql: "x", intent: "y", extra: 1 } }])
        .success,
    ).toBe(false);
  });

  it("refuses text over its cap, records out of order, and too many records", () => {
    expect(
      batch([
        { ...attempted, statement: "x".repeat(AUDIT_TEXT_MAX.statement + 1) },
      ]).success,
    ).toBe(false);
    expect(batch([failed, attempted]).success).toBe(false);
    expect(batch([attempted, attempted]).success).toBe(false);
    const many = Array.from({ length: AUDIT_BATCH_MAX + 1 }, (_, i) => ({
      ...failed,
      seq: i + 1,
    }));
    expect(batch(many).success).toBe(false);
    expect(batch([]).success).toBe(false);
  });
});

describe("AuditEventSchema", () => {
  it("reads DECIDED events written before masked and policy_version existed", () => {
    expect(
      AuditEventSchema.safeParse({
        event: "DECIDED",
        query_id: "q",
        at: "2026-09-30T00:00:00Z",
        verdict: "allow",
        rule: null,
        reason: null,
        class: null,
        fingerprint: null,
        tables: [],
        taints: false,
      }).success,
    ).toBe(true);
  });
});

describe("the bundle's audit field", () => {
  const bundle = {
    v: 1,
    iss: "https://cloud.example",
    project_id: "p",
    version: 2,
    iat: 0,
    paused: false,
    jwks: { keys: [] },
    databases: {},
  };

  it("lists the databases whose statements go up as written", () => {
    expect(
      BundlePayloadSchema.parse({ ...bundle, audit: { full_text: ["main"] } })
        .audit,
    ).toEqual({ full_text: ["main"] });
    expect(BundlePayloadSchema.parse(bundle).audit).toBeUndefined();
  });

  it("reads as absent when malformed, so nothing goes up in full", () => {
    const parsed = BundlePayloadSchema.safeParse({
      ...bundle,
      audit: { full_text: "main" },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.audit).toBeUndefined();
  });
});

describe("the status's audit head", () => {
  const status = {
    bundle_version: 1,
    state: "enforcing",
    reason: null,
    rejected: null,
    version: "0.21.0",
    features: [],
    databases: ["main"],
    nonce: "n".repeat(22),
  };

  it("is optional and strict", () => {
    expect(GatewayStatusSchema.safeParse(status).success).toBe(true);
    const head = {
      instance: "6f1c0b9e-instance",
      seq: 7,
      hash: HASH,
      unacked: 0,
    };
    expect(
      GatewayStatusSchema.safeParse({ ...status, audit: head }).success,
    ).toBe(true);
    expect(
      GatewayStatusSchema.safeParse({
        ...status,
        audit: { ...head, body: "x" },
      }).success,
    ).toBe(false);
  });
});
