// Schema-level baseline tests. No DB required — validates the Drizzle schema
// shape compiles and matches the OSS audit_events column set + cloud-side
// additions (customer_id, region).

import { describe, expect, it } from "vitest";

import {
  REGIONS,
  auditEventsIndex,
  connections,
  customers,
} from "../src/schema.ts";

describe("schema parity with OSS audit_events", () => {
  it("audit_events_index has all OSS columns plus customer_id, tenant_id, region", () => {
    const cols = Object.keys(auditEventsIndex);
    // OSS columns (from packages/engine/src/audit/schema.sql)
    for (const col of [
      "id",
      "queryId",
      "agentIdentity",
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
  });
});

describe("regions", () => {
  it("ships fra and iad as the V1 region set", () => {
    expect(REGIONS).toEqual(["fra", "iad"]);
  });
});

describe("connections", () => {
  it("carries the columns the router needs to mint MCP URLs", () => {
    const cols = Object.keys(connections);
    for (const col of [
      "id",
      "customerId",
      "region",
      "encryptedDsn",
      "kmsKeyId",
      "mcpToken",
      "lastKmsSuccessAt",
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
