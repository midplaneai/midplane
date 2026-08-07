// The approvals config must survive the SPAWN mapping into the engine's YAML.
//
// This exists because of a fail-open that shipped past the whole approvals test
// suite. Every unit test built a DatabaseEntry by hand and asserted the
// serializer emitted the right thing — which it did. Nothing asserted that the
// real spawn path actually POPULATES that field, and it didn't: `SpawnDatabase`
// had no `approvals`, so `toDatabaseEntry` produced an entry with approvals
// undefined, the serializer correctly emitted no block and no feature token, and
// the engine ran every write unapproved.
//
// The lesson encoded here: for a fail-CLOSED control, testing the formatter is
// not testing the feature. Assert on the bytes the engine receives.

import { describe, expect, it } from "vitest";
import { load as loadYaml } from "js-yaml";

import { serializeMultiDbPolicyToYaml } from "@midplane-cloud/db/policy";
import { toDatabaseEntry, type SpawnDatabase } from "../src/spawner.ts";

function spawnDb(overrides: Partial<SpawnDatabase> = {}): SpawnDatabase {
  return {
    name: "main",
    projectDatabaseId: "01HXYZ123ABC456DEF789GHI01",
    dsn: "postgres://stub",
    tableAccess: { default: "read", tables: { orders: "read_write" } },
    tenantScope: { column: null, overrides: {}, exempt: [] },
    guardrails: { block_unqualified_dml: true, block_ddl: true },
    ...overrides,
  };
}

/** What the engine actually parses at boot. */
function yamlFor(db: SpawnDatabase): Record<string, unknown> {
  const parsed = loadYaml(serializeMultiDbPolicyToYaml([toDatabaseEntry(db)])) as {
    databases: Record<string, unknown>[];
  };
  return parsed.databases[0]!;
}

describe("spawn → engine YAML carries approvals", () => {
  it("emits the block AND the feature token when approvals are on", () => {
    const entry = yamlFor(
      spawnDb({ approvals: { writes: true, expires_after_seconds: 1800 } }),
    );
    expect(entry.approvals).toEqual({ writes: true });
    // The token is the fail-closed interlock: an engine that does not know
    // `write_approvals` refuses the whole policy rather than running writes
    // unapproved. Losing it is how a missing field becomes a silent bypass.
    expect(entry.requires_features).toContain("write_approvals");
  });

  it("emits nothing when approvals are off", () => {
    const entry = yamlFor(
      spawnDb({ approvals: { writes: false, expires_after_seconds: 1800 } }),
    );
    expect(entry.approvals).toBeUndefined();
    expect(entry.requires_features).toBeUndefined();
  });

  it("a spawn mapping that drops the field is indistinguishable from OFF", () => {
    // The exact fail-open, pinned. If someone adds a field to SpawnDatabase and
    // forgets toDatabaseEntry again, the two objects below diverge.
    const omitted = yamlFor(spawnDb());
    const off = yamlFor(
      spawnDb({ approvals: { writes: false, expires_after_seconds: 1800 } }),
    );
    expect(omitted).toEqual(off);
  });

  it("toDatabaseEntry forwards approvals rather than defaulting it", () => {
    const on = { writes: true, expires_after_seconds: 600 };
    expect(toDatabaseEntry(spawnDb({ approvals: on })).approvals).toEqual(on);
  });

  it("coexists with column masks on one requires_features list", () => {
    const entry = yamlFor(
      spawnDb({
        approvals: { writes: true, expires_after_seconds: 1800 },
        columnMasks: { "public.customers": { email: "full-redact" } },
      }),
    );
    expect(entry.requires_features).toEqual([
      "column_masks",
      "mask_source_rewrite",
      "write_approvals",
    ]);
  });
});
