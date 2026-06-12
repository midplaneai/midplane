// Validator + YAML serializer for the table_access policy. The validator
// is the gate that keeps malformed policies out of Postgres; the spawner
// trusts post-write rows. Every reject case here corresponds to a real
// way a hostile or buggy caller could try to break the engine spawn.

import { describe, expect, it } from "vitest";

import {
  ACCESS_LEVELS,
  DB_NAME_RE,
  DEFAULT_GUARDRAILS,
  DEFAULT_POLICY,
  dsnEnvVarFor,
  isValidDbName,
  parseGuardrailsOrThrow,
  parsePolicyOrThrow,
  serializeMultiDbPolicyToYaml,
  validateGuardrails,
  validatePolicy,
  type DatabaseEntry,
  type TableAccessPolicy,
} from "../src/policy.ts";

describe("validatePolicy", () => {
  it("accepts the default-deny baseline", () => {
    const r = validatePolicy(DEFAULT_POLICY);
    expect(r.ok).toBe(true);
  });

  it("accepts each level for default", () => {
    for (const level of ACCESS_LEVELS) {
      const r = validatePolicy({ default: level, tables: {} });
      expect(r.ok).toBe(true);
    }
  });

  it("accepts schema-qualified table names", () => {
    const r = validatePolicy({
      default: "deny",
      tables: { "public.users": "read", "analytics.orders": "read_write" },
    });
    expect(r.ok).toBe(true);
  });

  it("normalizes missing tables field to empty", () => {
    const r = validatePolicy({ default: "read" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tables).toEqual({});
  });

  it("rejects non-object input", () => {
    for (const bad of [null, undefined, 42, "deny", []]) {
      const r = validatePolicy(bad);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects unknown default level", () => {
    const r = validatePolicy({ default: "admin", tables: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe("default");
  });

  it("rejects unknown per-table level", () => {
    const r = validatePolicy({
      default: "deny",
      tables: { users: "writeonly" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe("tables.users");
  });

  it("rejects table names that don't match the regex", () => {
    const cases = ["1users", "users users", "users;DROP", "", "x".repeat(200)];
    for (const name of cases) {
      const r = validatePolicy({
        default: "deny",
        tables: { [name]: "read" },
      });
      expect(r.ok, `should reject "${name}"`).toBe(false);
    }
  });

  it("rejects an array as the tables field", () => {
    const r = validatePolicy({ default: "deny", tables: ["users"] });
    expect(r.ok).toBe(false);
  });

  it("rejects more than 1000 tables", () => {
    const tables: Record<string, "read"> = {};
    for (let i = 0; i < 1001; i++) tables[`t${i}`] = "read";
    const r = validatePolicy({ default: "deny", tables });
    expect(r.ok).toBe(false);
  });
});

// Lock the cloud validator's accept/reject set against the engine's
// PolicyFileSchema. Any drift means the engine returns 400 to the
// cloud's POST /admin/policy after the cloud already committed to PG —
// which puts the connection into the "engine rejects, PG holds bad
// row" state that EnginePolicyRejected exists to surface. Catching it
// here keeps validators in lockstep before the engine ever sees a
// hot-reload request.
//
// Sourced from the engine's PolicyFileSchema (zod), as of the
// /admin/policy ship. If the engine schema tightens, mirror the new
// rejection here in the same PR that bumps the OSS image.
describe("cloud ⇄ engine validator parity", () => {
  const engineAccepts: Array<{ desc: string; policy: unknown }> = [
    { desc: "default deny + empty tables", policy: { default: "deny", tables: {} } },
    { desc: "default read", policy: { default: "read", tables: {} } },
    { desc: "default read_write", policy: { default: "read_write", tables: {} } },
    {
      desc: "schema-qualified table",
      policy: { default: "deny", tables: { "public.users": "read" } },
    },
    {
      desc: "$ in identifier (postgres-conventional)",
      policy: { default: "deny", tables: { "audit$archive": "read" } },
    },
    {
      desc: "1000 tables (max)",
      policy: {
        default: "deny",
        tables: Object.fromEntries(
          Array.from({ length: 1000 }, (_, i) => [`t${i}`, "read"]),
        ),
      },
    },
    {
      desc: "128-char table name (max)",
      policy: {
        default: "deny",
        tables: { [`a${"x".repeat(127)}`]: "read" },
      },
    },
  ];

  for (const { desc, policy } of engineAccepts) {
    it(`accepts: ${desc}`, () => {
      expect(validatePolicy(policy).ok).toBe(true);
    });
  }

  const engineRejects: Array<{ desc: string; policy: unknown }> = [
    { desc: "default = arbitrary string", policy: { default: "admin", tables: {} } },
    { desc: "default = numeric", policy: { default: 1, tables: {} } },
    { desc: "table name with space", policy: { default: "deny", tables: { "user table": "read" } } },
    { desc: "table name with semicolon", policy: { default: "deny", tables: { "users;DROP": "read" } } },
    { desc: "table name starting with digit", policy: { default: "deny", tables: { "1users": "read" } } },
    { desc: "empty table name", policy: { default: "deny", tables: { "": "read" } } },
    { desc: "129-char table name", policy: { default: "deny", tables: { [`a${"x".repeat(128)}`]: "read" } } },
    { desc: "1001 tables", policy: { default: "deny", tables: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`t${i}`, "read"])) } },
    { desc: "wildcard table", policy: { default: "deny", tables: { "*": "read" } } },
    { desc: "tables = array", policy: { default: "deny", tables: ["users"] } },
    { desc: "two-dot schema (a.b.c)", policy: { default: "deny", tables: { "a.b.c": "read" } } },
  ];

  for (const { desc, policy } of engineRejects) {
    it(`rejects: ${desc}`, () => {
      expect(validatePolicy(policy).ok).toBe(false);
    });
  }
});

// Mirrors the engine 0.9.0 GuardrailsSchema: each flag a boolean
// defaulting to true, the whole section defaulting to both-on when
// omitted. The omitted-section default matters most — a JSONB null
// (row predating the 0021 column) must read as protected, not off.
describe("validateGuardrails", () => {
  it("null/undefined resolve to the default-ON posture", () => {
    for (const input of [null, undefined]) {
      const r = validateGuardrails(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toEqual(DEFAULT_GUARDRAILS);
    }
  });

  it("a missing flag defaults to true (engine-side .default(true))", () => {
    const r = validateGuardrails({ block_ddl: false });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toEqual({ block_unqualified_dml: true, block_ddl: false });
  });

  it("accepts explicit opt-out of both flags", () => {
    const r = validateGuardrails({
      block_unqualified_dml: false,
      block_ddl: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value).toEqual({
        block_unqualified_dml: false,
        block_ddl: false,
      });
  });

  it("rejects non-boolean flags (engine parity: z.boolean())", () => {
    for (const bad of ["true", 1, {}, []]) {
      const r = validateGuardrails({ block_ddl: bad });
      expect(r.ok, `should reject block_ddl=${JSON.stringify(bad)}`).toBe(false);
      if (!r.ok) expect(r.errors[0]?.path).toBe("block_ddl");
    }
  });

  it("rejects non-object input", () => {
    for (const bad of [42, "on", []]) {
      expect(validateGuardrails(bad).ok).toBe(false);
    }
  });

  it("ignores unknown keys (engine parity: non-strict z.object)", () => {
    const r = validateGuardrails({ block_ddl: false, block_create: true });
    expect(r.ok).toBe(true);
  });
});

describe("parseGuardrailsOrThrow", () => {
  it("returns the typed value on success", () => {
    const v = parseGuardrailsOrThrow({ block_unqualified_dml: false });
    expect(v).toEqual({ block_unqualified_dml: false, block_ddl: true });
  });

  it("throws with a useful message on failure", () => {
    expect(() => parseGuardrailsOrThrow({ block_ddl: "yes" })).toThrow(
      /invalid guardrails/,
    );
  });
});

describe("parsePolicyOrThrow", () => {
  it("returns the typed value on success", () => {
    const v = parsePolicyOrThrow({ default: "read", tables: { x: "deny" } });
    expect(v.default).toBe("read");
    expect(v.tables.x).toBe("deny");
  });

  it("throws with a useful message on failure", () => {
    expect(() => parsePolicyOrThrow({ default: "nope" })).toThrow(
      /invalid table_access policy/,
    );
  });
});

describe("isValidDbName", () => {
  it("accepts names matching the OSS regex", () => {
    for (const name of ["main", "analytics", "prod-eu", "db_2", "a", "x".repeat(32)]) {
      expect(isValidDbName(name), name).toBe(true);
    }
  });

  it("rejects uppercase, leading digit, leading punct, or too long", () => {
    for (const name of ["Main", "1main", "-main", "_main", "main!", "x".repeat(33)]) {
      expect(isValidDbName(name), name).toBe(false);
    }
  });

  it("rejects the reserved __default__ name", () => {
    expect(isValidDbName("__default__")).toBe(false);
  });

  it("only matches the documented regex", () => {
    expect(DB_NAME_RE.source).toBe("^[a-z][a-z0-9_-]{0,31}$");
  });
});

describe("dsnEnvVarFor", () => {
  it("accepts ULID ids (uppercase Crockford base32)", () => {
    // 26-char uppercase alphanumeric — the shape new code generates via ulid().
    const id = "01HXYZ123ABC456DEF789GHI01";
    expect(dsnEnvVarFor(id)).toBe(`MIDPLANE_DSN_${id}`);
    expect(/^[A-Z_][A-Z0-9_]*$/.test(dsnEnvVarFor(id))).toBe(true);
  });

  it("accepts 32-char uppercase hex (the migration 0009 backfill shape)", () => {
    // Matches `upper(replace(gen_random_uuid()::text, '-', ''))` in the
    // backfill — every character is in [A-F0-9], a strict subset of the
    // OSS-accepted [A-Z0-9_]. This is the case the reviewer flagged: a
    // raw lowercase-with-hyphens UUID would have failed engine boot.
    const id = "A1B2C3D4E5F67890ABCDEF1234567890";
    expect(dsnEnvVarFor(id)).toBe(`MIDPLANE_DSN_${id}`);
    expect(/^[A-Z_][A-Z0-9_]*$/.test(dsnEnvVarFor(id))).toBe(true);
  });

  it("throws on raw UUIDs (lowercase + hyphens) so we fail at the boundary", () => {
    // What gen_random_uuid()::text would have produced before the
    // backfill was upper+strip-dashed. OSS env-interpolation regex
    // would silently fail to substitute, leaving `${MIDPLANE_DSN_…}`
    // as a literal url string; the engine then refuses the connection.
    expect(() => dsnEnvVarFor("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toThrow(
      /OSS env-interpolation regex/,
    );
  });

  it("throws on lowercase-only ids", () => {
    expect(() => dsnEnvVarFor("lowercase")).toThrow(/OSS env-interpolation regex/);
  });

  it("throws on ids containing dots or other punctuation", () => {
    expect(() => dsnEnvVarFor("ABC.DEF")).toThrow(/OSS env-interpolation regex/);
    expect(() => dsnEnvVarFor("ABC DEF")).toThrow(/OSS env-interpolation regex/);
  });
});

describe("serializeMultiDbPolicyToYaml", () => {
  function entry(overrides: Partial<DatabaseEntry> = {}): DatabaseEntry {
    return {
      name: "main",
      connectionDatabaseId: "01HXYZ123ABC456DEF789GHI01",
      tableAccess: { default: "read", tables: {} },
      tenantScope: { column: null, overrides: {}, exempt: [] },
      guardrails: { block_unqualified_dml: true, block_ddl: true },
      ...overrides,
    };
  }

  it("emits a single-DB entry with table_access + guardrails, no tenant_scope when config is inert", () => {
    const yaml = serializeMultiDbPolicyToYaml([entry()]);
    expect(yaml).toBe(
      [
        "databases:",
        "  - name: main",
        "    url: ${MIDPLANE_DSN_01HXYZ123ABC456DEF789GHI01}",
        "    table_access:",
        "      default: read",
        "      tables: {}",
        "    guardrails:",
        "      block_unqualified_dml: true",
        "      block_ddl: true",
        "",
      ].join("\n"),
    );
  });

  it("emits guardrails opt-outs literally — false must reach the engine, since an omitted section defaults ON", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        guardrails: { block_unqualified_dml: false, block_ddl: false },
      }),
    ]);
    expect(yaml).toContain("      block_unqualified_dml: false");
    expect(yaml).toContain("      block_ddl: false");
  });

  it("emits OSS 0.5.0 strict-mode shape: column + overrides + exempt, each sorted", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        tableAccess: {
          default: "deny",
          tables: { users: "read_write", "public.orders": "deny", audit: "read" },
        },
        tenantScope: {
          column: "tenant_id",
          overrides: { orders: "org_id", users: "customer_id" },
          exempt: ["regions", "audit_log"],
        },
      }),
    ]);
    const expected = [
      "databases:",
      "  - name: main",
      "    url: ${MIDPLANE_DSN_01HXYZ123ABC456DEF789GHI01}",
      "    table_access:",
      "      default: deny",
      "      tables:",
      "        audit: read",
      "        public.orders: deny",
      "        users: read_write",
      "    tenant_scope:",
      "      enabled: true",
      "      column: tenant_id",
      "      overrides:",
      "        orders: org_id",
      "        users: customer_id",
      "      exempt:",
      "        - audit_log",
      "        - regions",
      "    guardrails:",
      "      block_unqualified_dml: true",
      "      block_ddl: true",
      "",
    ].join("\n");
    expect(yaml).toBe(expected);
  });

  it("column=null + overrides-only: emits the same YAML 0.5.0 reads as the deprecated `mappings`-equivalent", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        tenantScope: {
          column: null,
          overrides: { orders: "tenant_id" },
          exempt: [],
        },
      }),
    ]);
    expect(yaml).toContain("tenant_scope:");
    expect(yaml).toContain("      enabled: true");
    expect(yaml).not.toContain("column:");
    expect(yaml).toContain("      overrides:");
    expect(yaml).toContain("        orders: tenant_id");
    expect(yaml).not.toContain("exempt:");
  });

  it("accepts schema-qualified table names in overrides + exempt (matches table_access + introspection autocomplete)", () => {
    // The shared TableNameInput autocomplete fills `schema.table` from
    // information_schema. table_access already accepts that shape;
    // tenant_scope overrides + exempt must too, otherwise a value the
    // operator selected from the dropdown would fail validation.
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        tenantScope: {
          column: "tenant_id",
          overrides: { "public.users": "customer_id" },
          exempt: ["public.regions"],
        },
      }),
    ]);
    expect(yaml).toContain("        public.users: customer_id");
    expect(yaml).toContain("        - public.regions");
  });

  it("rejects schema-qualified values in column or override values (those are columns, not tables)", () => {
    // The split: keys are table identifiers (TABLE_IDENT_RE), values are
    // column identifiers (IDENT_RE). A dot belongs in the key, not the
    // value — a tenant column is always a single unqualified name.
    expect(() =>
      serializeMultiDbPolicyToYaml([
        entry({
          tenantScope: {
            column: "public.tenant_id",
            overrides: {},
            exempt: [],
          },
        }),
      ]),
    ).toThrow(/quoting/);
    expect(() =>
      serializeMultiDbPolicyToYaml([
        entry({
          tenantScope: {
            column: null,
            overrides: { orders: "public.org_id" },
            exempt: [],
          },
        }),
      ]),
    ).toThrow(/quoting/);
  });

  it("emits exempt-only configs without overrides (still inert per tenantScopeIsActive but worth being deterministic)", () => {
    // Inert configs (no column AND no overrides) skip the block entirely
    // regardless of exempt — exempting tables that aren't scoped is a
    // no-op, so we don't waste bytes on YAML the engine will treat as
    // disabled anyway.
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        tenantScope: {
          column: null,
          overrides: {},
          exempt: ["audit_log"],
        },
      }),
    ]);
    expect(yaml).not.toContain("tenant_scope:");
  });

  it("emits multiple DBs, each with its own block", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({ name: "prod", connectionDatabaseId: "01HXYZA000000000000000000A" }),
      entry({ name: "analytics", connectionDatabaseId: "01HXYZB000000000000000000B" }),
    ]);
    expect(yaml).toContain("  - name: prod\n    url: ${MIDPLANE_DSN_01HXYZA000000000000000000A}");
    expect(yaml).toContain("  - name: analytics\n    url: ${MIDPLANE_DSN_01HXYZB000000000000000000B}");
  });

  it("rejects an empty databases array", () => {
    expect(() => serializeMultiDbPolicyToYaml([])).toThrow(/at least one database/);
  });

  it("rejects invalid DB names", () => {
    expect(() => serializeMultiDbPolicyToYaml([entry({ name: "Bad" })])).toThrow(
      /invalid database name/,
    );
    expect(() =>
      serializeMultiDbPolicyToYaml([entry({ name: "__default__" })]),
    ).toThrow(/invalid database name/);
  });

  it("rejects duplicate names", () => {
    expect(() =>
      serializeMultiDbPolicyToYaml([
        entry({ name: "main" }),
        entry({ name: "main", connectionDatabaseId: "01HXYZB000000000000000000B" }),
      ]),
    ).toThrow(/duplicate database name/);
  });

  it("rejects tenant_scope override keys/values that need quoting", () => {
    expect(() =>
      serializeMultiDbPolicyToYaml([
        entry({
          tenantScope: {
            column: null,
            overrides: { "bad name": "tenant_id" },
            exempt: [],
          },
        }),
      ]),
    ).toThrow(/quoting/);
  });

  it("rejects a tenant_scope.column that needs quoting", () => {
    expect(() =>
      serializeMultiDbPolicyToYaml([
        entry({
          tenantScope: {
            column: "bad column",
            overrides: {},
            exempt: [],
          },
        }),
      ]),
    ).toThrow(/quoting/);
  });

  it("rejects a tenant_scope.exempt entry that needs quoting", () => {
    expect(() =>
      serializeMultiDbPolicyToYaml([
        entry({
          tenantScope: {
            column: "tenant_id",
            overrides: {},
            exempt: ["bad name"],
          },
        }),
      ]),
    ).toThrow(/quoting/);
  });

  it("never quotes — only validated identifiers reach this function", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        tableAccess: { default: "read", tables: { "schema_1.table$2": "read" } },
      }),
    ]);
    expect(yaml).not.toContain('"');
    expect(yaml).not.toContain("'");
  });
});
