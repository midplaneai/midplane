// Validator + YAML serializer for the table_access policy. The validator
// is the gate that keeps malformed policies out of Postgres; the spawner
// trusts post-write rows. Every reject case here corresponds to a real
// way a hostile or buggy caller could try to break the engine spawn.

import { describe, expect, it } from "vitest";

import {
  ACCESS_LEVELS,
  DB_NAME_RE,
  DEFAULT_POLICY,
  dsnEnvVarFor,
  isValidDbName,
  parsePolicyOrThrow,
  serializeMultiDbPolicyToYaml,
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
  it("produces a name matching the OSS env-interpolation regex", () => {
    // ULID = uppercase Crockford base32, 26 chars. Combined prefix is
    // uppercase ASCII so the result matches OSS ENV_INTERP_RE [A-Z_][A-Z0-9_]*.
    const id = "01HXYZ123ABC456DEF789GHI01"; // ULID-shaped fixture
    expect(dsnEnvVarFor(id)).toBe(`MIDPLANE_DSN_${id}`);
    expect(/^[A-Z_][A-Z0-9_]*$/.test(dsnEnvVarFor(id))).toBe(true);
  });
});

describe("serializeMultiDbPolicyToYaml", () => {
  function entry(overrides: Partial<DatabaseEntry> = {}): DatabaseEntry {
    return {
      name: "main",
      connectionDatabaseId: "01HXYZ123ABC456DEF789GHI01",
      tableAccess: { default: "read", tables: {} },
      tenantScopeMappings: {},
      ...overrides,
    };
  }

  it("emits a single-DB entry with table_access, no tenant_scope when mappings empty", () => {
    const yaml = serializeMultiDbPolicyToYaml([entry()]);
    expect(yaml).toBe(
      [
        "databases:",
        "  - name: main",
        "    url: ${MIDPLANE_DSN_01HXYZ123ABC456DEF789GHI01}",
        "    table_access:",
        "      default: read",
        "      tables: {}",
        "",
      ].join("\n"),
    );
  });

  it("sorts table_access entries and per-DB tenant_scope mappings", () => {
    const yaml = serializeMultiDbPolicyToYaml([
      entry({
        tableAccess: {
          default: "deny",
          tables: { users: "read_write", "public.orders": "deny", audit: "read" },
        },
        tenantScopeMappings: { orders: "tenant_id", users: "customer_id" },
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
      "      mappings:",
      "        orders: tenant_id",
      "        users: customer_id",
      "",
    ].join("\n");
    expect(yaml).toBe(expected);
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

  it("rejects tenant_scope mapping keys/values that need quoting", () => {
    expect(() =>
      serializeMultiDbPolicyToYaml([
        entry({ tenantScopeMappings: { "bad name": "tenant_id" } }),
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
