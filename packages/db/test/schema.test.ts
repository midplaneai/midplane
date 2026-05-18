// Schema-level baseline tests. No DB required — validates the Drizzle schema
// shape compiles and matches the OSS audit_events column set + cloud-side
// additions (customer_id, region).

import { describe, expect, it } from "vitest";

import {
  REGIONS,
  auditEventsIndex,
  connectionDatabases,
  connections,
  customers,
} from "../src/schema.ts";

describe("schema parity with OSS audit_events", () => {
  it("audit_events_index has all OSS v2 columns plus customer_id, tenant_id, region, database", () => {
    const cols = Object.keys(auditEventsIndex);
    // OSS v2 columns (audit_events.schema_version 2 — OSS 0.3.0 split
    // agent_identity into agent_name + agent_version and added
    // agent_intent + intent_source). agentIdentity is also still on the
    // schema as a deprecated column kept for one rollout window so an
    // in-flight pre-bump indexer can still write to it without a 42703;
    // a follow-up migration drops both the column and the field.
    for (const col of [
      "id",
      "queryId",
      "agentIdentity",
      "agentName",
      "agentVersion",
      "agentIntent",
      "intentSource",
      "ts",
      "eventType",
      "payload",
      "schemaVersion",
    ]) {
      expect(cols).toContain(col);
    }
    // Cloud-side additions
    expect(cols).toContain("customerId");
    expect(cols).toContain("tenantId");
    expect(cols).toContain("region");
    // 0009: per-DB attribution from OSS 0.2.0 audit pull payload.
    expect(cols).toContain("database");
  });
});

describe("regions", () => {
  it("ships eu and us as the V1 region set", () => {
    expect(REGIONS).toEqual(["eu", "us"]);
  });
});

describe("connections (0008-slimmed parent)", () => {
  it("holds identity + token only — credential columns moved to connection_databases", () => {
    const cols = Object.keys(connections);
    for (const col of [
      "id",
      "customerId",
      "region",
      "name",
      "mcpToken",
      "createdAt",
    ]) {
      expect(cols).toContain(col);
    }
    // Moved to connection_databases in migration 0008. Asserting absence
    // here protects against accidentally re-adding the column to the
    // parent (which would silently regress the per-credential cache fence
    // and KMS grace-window tracking).
    for (const col of [
      "encryptedDsn",
      "kmsKeyId",
      "tableAccess",
      "rotatedAt",
      "lastKmsSuccessAt",
    ]) {
      expect(cols).not.toContain(col);
    }
  });
});

describe("connection_databases (0008 child)", () => {
  it("carries per-credential state and per-DB policy", () => {
    const cols = Object.keys(connectionDatabases);
    for (const col of [
      "id",
      "connectionId",
      "name",
      "encryptedDsn",
      "kmsKeyId",
      "tableAccess",
      "tenantScope",
      "rotatedAt",
      "lastKmsSuccessAt",
      "createdAt",
    ]) {
      expect(cols).toContain(col);
    }
  });
});

describe("customers", () => {
  it("carries Clerk linkage and an immutable region", () => {
    const cols = Object.keys(customers);
    for (const col of ["id", "clerkUserId", "email", "region"]) {
      expect(cols).toContain(col);
    }
  });
});
