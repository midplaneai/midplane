// Validator + YAML serializer for the table_access policy. The validator
// is the gate that keeps malformed policies out of Postgres; the spawner
// trusts post-write rows. Every reject case here corresponds to a real
// way a hostile or buggy caller could try to break the engine spawn.

import { describe, expect, it } from "vitest";

import {
  ACCESS_LEVELS,
  DEFAULT_POLICY,
  parsePolicyOrThrow,
  serializePolicyToYaml,
  validatePolicy,
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

describe("serializePolicyToYaml", () => {
  it("wraps under table_access: with sorted table keys", () => {
    const policy: TableAccessPolicy = {
      default: "read",
      tables: { users: "read_write", "public.orders": "deny", audit: "read" },
    };
    const yaml = serializePolicyToYaml(policy);
    expect(yaml).toBe(
      [
        "table_access:",
        "  default: read",
        "  tables:",
        "    audit: read",
        "    public.orders: deny",
        "    users: read_write",
        "",
      ].join("\n"),
    );
  });

  it("emits empty tables map when no overrides exist", () => {
    expect(serializePolicyToYaml({ default: "deny", tables: {} })).toBe(
      "table_access:\n  default: deny\n  tables: {}\n",
    );
  });

  it("never quotes — only validated identifiers reach this function", () => {
    // Sanity: the serializer is only safe because the validator's regex
    // forbids characters that would need YAML quoting. If the regex ever
    // widens, this test should fail and force a quoting step here.
    const yaml = serializePolicyToYaml({
      default: "read",
      tables: { "schema_1.table$2": "read" },
    });
    expect(yaml).not.toContain('"');
    expect(yaml).not.toContain("'");
  });
});
