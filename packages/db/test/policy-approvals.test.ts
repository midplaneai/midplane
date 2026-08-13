import { describe, expect, it } from "vitest";
import { load as loadYaml } from "js-yaml";

import {
  DEFAULT_APPROVALS,
  applyWriteRules,
  approvalsAreActive,
  parseApprovalsOrThrow,
  parseWriteRulesOrThrow,
  serializeMultiDbPolicyToYaml,
  validateApprovals,
  validateWriteRules,
  writeRulesFrom,
  type ApprovalsConfig,
  type DatabaseEntry,
} from "../src/policy.ts";

function entry(overrides: Partial<DatabaseEntry> = {}): DatabaseEntry {
  return {
    name: "main",
    projectDatabaseId: "01HXYZ123ABC456DEF789GHI01",
    tableAccess: { default: "read", tables: { orders: "read_write" } },
    tenantScope: { column: null, overrides: {}, exempt: [] },
    guardrails: { block_unqualified_dml: true, block_ddl: true, block_dml: false },
    ...overrides,
  };
}

const ON: ApprovalsConfig = {
  row_changes: true,
  whole_table_writes: true,
  schema_changes: true,
  expires_after_seconds: 1800,
};

describe("validateApprovals", () => {
  it("resolves an absent section to off", () => {
    for (const input of [null, undefined]) {
      const r = validateApprovals(input);
      expect(r).toEqual({ ok: true, value: DEFAULT_APPROVALS });
    }
  });

  it("never hands back the shared default object", () => {
    const a = validateApprovals(null);
    const b = validateApprovals(null);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error("unreachable");
    a.value.row_changes = true;
    // Mutating one result must not poison the module default for the process.
    expect(b.value.row_changes).toBe(false);
    expect(DEFAULT_APPROVALS.row_changes).toBe(false);
  });

  it("accepts a well-formed config", () => {
    const r = validateApprovals({ ...ON, expires_after_seconds: 600 });
    expect(r).toEqual({
      ok: true,
      value: { ...ON, expires_after_seconds: 600 },
    });
  });

  it("reads a legacy `writes` boolean as that value for every class", () => {
    // A row written before the per-class split. Reading it as anything else
    // would silently change what that database enforces on its next spawn.
    const r = validateApprovals({ writes: true, expires_after_seconds: 600 });
    expect(r).toEqual({
      ok: true,
      value: {
        row_changes: true,
        whole_table_writes: true,
        schema_changes: true,
        expires_after_seconds: 600,
      },
    });
    expect(validateApprovals({ writes: false })).toEqual({
      ok: true,
      value: DEFAULT_APPROVALS,
    });
  });

  it("lets an explicit class override the legacy umbrella", () => {
    const r = validateApprovals({ writes: true, row_changes: false });
    expect(r.ok && r.value).toEqual({
      row_changes: false,
      whole_table_writes: true,
      schema_changes: true,
      expires_after_seconds: 1800,
    });
  });

  it("accepts a partial per-class config, defaulting the rest to off", () => {
    const r = validateApprovals({ schema_changes: true });
    expect(r.ok && r.value).toEqual({
      row_changes: false,
      whole_table_writes: false,
      schema_changes: true,
      expires_after_seconds: 1800,
    });
  });

  it("rejects a non-boolean class flag", () => {
    const r = validateApprovals({ schema_changes: "true" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual([
      { path: "schema_changes", message: "must be a boolean" },
    ]);
  });

  it("fills unspecified fields from the default", () => {
    const r = validateApprovals({ writes: true });
    expect(r.ok && r.value.expires_after_seconds).toBe(1800);
  });

  it("rejects a non-boolean writes", () => {
    // "true" is the shape a form post would produce if someone forgot to coerce.
    const r = validateApprovals({ writes: "true" });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.errors).toEqual([{ path: "writes", message: "must be a boolean" }]);
  });

  it("rejects an expiry outside the supported window", () => {
    for (const bad of [0, 59, 86_401, -1800]) {
      const r = validateApprovals({ writes: true, expires_after_seconds: bad });
      expect(r.ok).toBe(false);
    }
    for (const good of [60, 1800, 86_400]) {
      const r = validateApprovals({ writes: true, expires_after_seconds: good });
      expect(r.ok).toBe(true);
    }
  });

  it("rejects a non-integer expiry", () => {
    const r = validateApprovals({ writes: true, expires_after_seconds: 90.5 });
    expect(r.ok).toBe(false);
  });

  it("rejects non-objects", () => {
    for (const bad of [[], "writes", 7, true]) {
      expect(validateApprovals(bad).ok).toBe(false);
    }
  });

  it("parseApprovalsOrThrow fails closed on invalid input", () => {
    expect(() => parseApprovalsOrThrow({ writes: 1 })).toThrow(/invalid approvals/);
    expect(parseApprovalsOrThrow(null)).toEqual(DEFAULT_APPROVALS);
  });
});

describe("approvalsAreActive", () => {
  it("is false for the default and true once any class is held", () => {
    expect(approvalsAreActive(DEFAULT_APPROVALS)).toBe(false);
    expect(approvalsAreActive(ON)).toBe(true);
    expect(
      approvalsAreActive({ ...DEFAULT_APPROVALS, schema_changes: true }),
    ).toBe(true);
    // Expiry alone is not activation — it only governs an existing request.
    expect(
      approvalsAreActive({ ...DEFAULT_APPROVALS, expires_after_seconds: 60 }),
    ).toBe(false);
  });
});

describe("serializeMultiDbPolicyToYaml — approvals", () => {
  it("omits the block entirely when approvals are off", () => {
    // The whole point: a database not using approvals must serialize exactly as
    // it did before the feature existed, so nothing about its engine changes.
    const withField = serializeMultiDbPolicyToYaml([entry({ approvals: DEFAULT_APPROVALS })]);
    const withoutField = serializeMultiDbPolicyToYaml([entry()]);
    expect(withField).toBe(withoutField);
    expect(withField).not.toContain("approvals");
    expect(withField).not.toContain("requires_features");
  });

  it("emits the block and the feature token when on", () => {
    const yaml = serializeMultiDbPolicyToYaml([entry({ approvals: ON })]);
    expect(yaml).toContain("    requires_features:\n      - write_approvals\n");
    expect(yaml).toContain("    approvals:\n      writes: true\n");
  });

  it("never leaks expires_after_seconds to the engine", () => {
    // Control-plane concern: the engine's hold is a fixed short window and it
    // has no use for the request's lifetime.
    const yaml = serializeMultiDbPolicyToYaml([
      entry({ approvals: { ...ON, expires_after_seconds: 600 } }),
    ]);
    expect(yaml).not.toContain("expires_after_seconds");
    expect(yaml).not.toContain("600");
  });

  it("emits ONE requires_features list when masks and approvals are both on", () => {
    // Regression guard: two emitters each writing `requires_features:` produces a
    // duplicate YAML key, and js-yaml's last-one-wins would silently drop a
    // fail-closed token — turning a refusing engine into a permissive one.
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        approvals: ON,
        columnMasks: { "public.customers": { email: "full-redact" } },
        maskSourceRewrite: true,
      }),
    ]);
    expect(yaml.match(/requires_features:/g)).toHaveLength(1);

    const parsed = loadYaml(yaml) as {
      databases: { requires_features: string[]; approvals: { writes: boolean } }[];
    };
    expect(parsed.databases[0]!.requires_features).toEqual([
      "column_masks",
      "mask_source_rewrite",
      "write_approvals",
    ]);
    expect(parsed.databases[0]!.approvals).toEqual({ writes: true });
  });

  it("requires only write_approvals when masks are absent", () => {
    const yaml = serializeMultiDbPolicyToYaml([entry({ approvals: ON })]);
    const parsed = loadYaml(yaml) as { databases: { requires_features: string[] }[] };
    expect(parsed.databases[0]!.requires_features).toEqual(["write_approvals"]);
  });

  it("does not require mask_source_rewrite for a database with no masks", () => {
    // The flag is inert without masks; requiring the feature would fail an
    // upgrade for zero enforcement gain.
    const yaml = serializeMultiDbPolicyToYaml([
      entry({ approvals: ON, maskSourceRewrite: true, columnMasks: {} }),
    ]);
    const parsed = loadYaml(yaml) as { databases: { requires_features: string[] }[] };
    expect(parsed.databases[0]!.requires_features).toEqual(["write_approvals"]);
    expect(yaml).not.toContain("mask_source_rewrite");
  });

  it("keeps approvals per-database in a multi-DB policy", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({ name: "main", approvals: ON }),
      entry({
        name: "replica",
        projectDatabaseId: "01HXYZ123ABC456DEF789GHI02",
        approvals: DEFAULT_APPROVALS,
      }),
    ]);
    const parsed = loadYaml(yaml) as {
      databases: { name: string; approvals?: unknown; requires_features?: string[] }[];
    };
    expect(parsed.databases[0]!.approvals).toEqual({ writes: true });
    expect(parsed.databases[0]!.requires_features).toEqual(["write_approvals"]);
    expect(parsed.databases[1]!.approvals).toBeUndefined();
    expect(parsed.databases[1]!.requires_features).toBeUndefined();
  });

  it("round-trips through YAML to the shape the engine schema expects", () => {
    const yaml = serializeMultiDbPolicyToYaml([entry({ approvals: ON })]);
    const parsed = loadYaml(yaml) as {
      databases: { approvals: Record<string, unknown> }[];
    };
    // Holding every class collapses to the umbrella `writes`. If this grows,
    // the engine schema has to grow with it in the same release.
    expect(Object.keys(parsed.databases[0]!.approvals)).toEqual(["writes"]);
  });

  it("states classes individually — and requires write_rules — when only some are held", () => {
    // The token is the whole defense here: an engine that predates per-class
    // approvals strips the unknown keys and resolves `writes` to its false
    // default, so it would hold NOTHING while the dashboard says it holds
    // schema changes. Refusing the policy is the only safe answer.
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        approvals: { ...DEFAULT_APPROVALS, schema_changes: true },
        guardrails: {
          block_unqualified_dml: false,
          block_ddl: false,
          block_dml: false,
        },
      }),
    ]);
    const parsed = loadYaml(yaml) as {
      databases: {
        approvals: Record<string, unknown>;
        requires_features: string[];
      }[];
    };
    expect(parsed.databases[0]!.approvals).toEqual({
      row_changes: false,
      whole_table_writes: false,
      schema_changes: true,
    });
    expect(parsed.databases[0]!.requires_features).toEqual([
      "write_approvals",
      "write_rules",
    ]);
  });

  it("still collapses to the umbrella when the un-held classes are ones a guardrail already refuses", () => {
    // block_ddl refuses schema changes before the approval stage runs, so
    // whether the umbrella also marks that class held changes no decision —
    // and `writes: true` needs no feature token, which keeps the common
    // "hold my writes" policy loadable by any engine.
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        approvals: { ...ON, schema_changes: false },
        guardrails: {
          block_unqualified_dml: false,
          block_ddl: true,
          block_dml: false,
        },
      }),
    ]);
    const parsed = loadYaml(yaml) as {
      databases: {
        approvals: Record<string, unknown>;
        requires_features: string[];
      }[];
    };
    expect(parsed.databases[0]!.approvals).toEqual({ writes: true });
    expect(parsed.databases[0]!.requires_features).toEqual(["write_approvals"]);
  });

  it("fences block_dml behind write_rules, and emits it only when on", () => {
    const off = serializeMultiDbPolicyToYaml([entry()]);
    expect(off).not.toContain("block_dml");
    expect(off).not.toContain("requires_features");

    const on = serializeMultiDbPolicyToYaml([
      entry({
        guardrails: {
          block_unqualified_dml: true,
          block_ddl: true,
          block_dml: true,
        },
      }),
    ]);
    expect(on).toContain("      block_dml: true\n");
    const parsed = loadYaml(on) as {
      databases: { requires_features: string[] }[];
    };
    expect(parsed.databases[0]!.requires_features).toEqual(["write_rules"]);
  });
});

describe("write rules", () => {
  it("reads refuse / ask / allow off the two stored configs", () => {
    expect(
      writeRulesFrom(
        {
          block_unqualified_dml: true,
          block_ddl: false,
          block_dml: false,
        },
        { ...DEFAULT_APPROVALS, schema_changes: true },
      ),
    ).toEqual({
      row_changes: "allow",
      whole_table_writes: "refuse",
      schema_changes: "ask",
    });
  });

  it("reports refuse when a class is both refused and held", () => {
    // Not a state the editor can produce, but a stored config can carry it
    // (an older approvals row plus a newly-enabled guardrail). The engine runs
    // guardrails first, so refuse is what actually happens.
    expect(
      writeRulesFrom(
        { block_unqualified_dml: true, block_ddl: true, block_dml: true },
        ON,
      ),
    ).toEqual({
      row_changes: "refuse",
      whole_table_writes: "refuse",
      schema_changes: "refuse",
    });
  });

  it("round-trips through applyWriteRules", () => {
    const rules = {
      row_changes: "ask",
      whole_table_writes: "refuse",
      schema_changes: "allow",
    } as const;
    const { guardrails, approvals } = applyWriteRules(rules, {
      ...DEFAULT_APPROVALS,
      expires_after_seconds: 600,
    });
    expect(guardrails).toEqual({
      block_dml: false,
      block_unqualified_dml: true,
      block_ddl: false,
    });
    expect(approvals).toEqual({
      row_changes: true,
      whole_table_writes: false,
      schema_changes: false,
      // Control-plane-only state the rules say nothing about: rebuilding it
      // from the default would reset a tuned window on every unrelated save.
      expires_after_seconds: 600,
    });
    expect(writeRulesFrom(guardrails, approvals)).toEqual(rules);
  });

  it("validates the three values and rejects anything else", () => {
    expect(
      validateWriteRules({
        row_changes: "allow",
        whole_table_writes: "ask",
        schema_changes: "refuse",
      }).ok,
    ).toBe(true);
    const missing = validateWriteRules({ row_changes: "allow" });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("unreachable");
    expect(missing.errors.map((e) => e.path)).toEqual([
      "whole_table_writes",
      "schema_changes",
    ]);
    expect(
      validateWriteRules({
        row_changes: "hold",
        whole_table_writes: "ask",
        schema_changes: "refuse",
      }).ok,
    ).toBe(false);
    expect(() => parseWriteRulesOrThrow(null)).toThrow(/invalid write rules/);
  });
});
