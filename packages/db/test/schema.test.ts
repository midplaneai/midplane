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
    // 0020: cloud-only connection attribution (FK ON DELETE SET NULL so
    // audit history survives connection deletion).
    expect(cols).toContain("connectionId");
  });
});

describe("regions", () => {
  it("ships eu and us as the V1 region set", () => {
    expect(REGIONS).toEqual(["eu", "us"]);
  });
});

describe("connections (0008-slimmed parent + 0018 cleanup)", () => {
  it("holds identity only — credential columns moved to connection_databases; mcp_token moved to mcp_tokens", () => {
    const cols = Object.keys(connections);
    for (const col of [
      "id",
      "customerId",
      "region",
      "name",
      "createdAt",
    ]) {
      expect(cols).toContain(col);
    }
    // Moved to connection_databases in migration 0008 (encryptedDsn etc.)
    // and to mcp_tokens in migration 0017/0018 (mcpToken). Asserting absence
    // here protects against accidentally re-adding any of them to the
    // parent: encryptedDsn would silently regress the per-credential cache
    // fence and KMS grace-window tracking; mcpToken would re-introduce the
    // plaintext bearer column the PR2 cleanup explicitly drops.
    for (const col of [
      "encryptedDsn",
      "kmsKeyId",
      "tableAccess",
      "rotatedAt",
      "lastKmsSuccessAt",
      "mcpToken",
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
      "guardrails",
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
    for (const col of ["id", "clerkOrgId", "email", "region"]) {
      expect(cols).toContain(col);
    }
  });
});
