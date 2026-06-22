// maskResultSet — decision-matrix unit pins over a synthetic catalog.
// (The end-to-end provenance reality — that real Postgres reports view/partition
//  OIDs the way these tests assume — is pinned separately in the live-PG
//  integration test.)

import { describe, expect, test } from "bun:test";
import {
  maskResultSet,
  type Catalog,
  type ColumnMasks,
  type RelInfo,
} from "../../src/masking/mask-result-set.ts";
import type { MaskRule } from "../../src/masking/transforms.ts";
import type { ResultField } from "../../src/executor.ts";

// OIDs mirror the provenance-probe schema shape.
const USERS = 100, ORDERS = 200, USERS_V = 300, USERS_MV = 350, EVENTS = 400, EVENTS_A = 401,
  PEOPLE = 500, INFO_TABLES = 9001;

// pg_type.typcategory letters per attnum drive the parametric domain checks:
// 'S' string, 'D' date/time, 'N' numeric. Omitting a column from `types` leaves
// its category unproven (a parametric rule on it then fail-closes).
const rel = (
  schema: string,
  relname: string,
  relkind: string,
  topParentOid: number,
  cols: Record<number, string>,
  types: Record<number, string> = {},
): RelInfo => ({
  schema,
  relname,
  relkind,
  topParentOid,
  columns: new Map(Object.entries(cols).map(([k, v]) => [Number(k), v])),
  columnTypes: new Map(Object.entries(types).map(([k, v]) => [Number(k), v])),
});

const CATALOG: Catalog = new Map([
  [USERS, rel("public", "users", "r", USERS, { 1: "id", 2: "email", 3: "ssn" }, { 1: "N", 2: "S", 3: "S" })],
  [ORDERS, rel("public", "orders", "r", ORDERS, { 1: "id", 2: "user_id", 3: "total" }, { 1: "N", 2: "N", 3: "N" })],
  [USERS_V, rel("public", "users_v", "v", USERS_V, { 1: "id", 2: "email" })],
  [USERS_MV, rel("public", "users_mv", "m", USERS_MV, { 1: "id", 2: "email" })],
  [EVENTS, rel("public", "events", "p", EVENTS, { 1: "id", 2: "tenant" }, { 1: "N", 2: "S" })],
  [EVENTS_A, rel("public", "events_a", "r", EVENTS, { 1: "id", 2: "tenant" }, { 1: "N", 2: "S" })], // child -> parent EVENTS
  // dob is a date (category 'D'), salary numeric ('N'), name text ('S') — drives
  // the generalize date/numeric domain tests.
  [PEOPLE, rel("public", "people", "r", PEOPLE, { 1: "id", 2: "dob", 3: "salary", 4: "name" }, { 1: "N", 2: "D", 3: "N", 4: "S" })],
  // information_schema.tables is a VIEW (relkind v) — selecting from it reports
  // this oid. Must be exempt, not rejected (schema discovery reads it).
  [INFO_TABLES, rel("information_schema", "tables", "v", INFO_TABLES, { 1: "table_schema", 2: "table_name" })],
]);

const MASKS: ColumnMasks = new Map([
  ["public.users", new Map<string, MaskRule>([
    ["email", "full-redact"],
    ["ssn", "consistent-hash"],
  ])],
  ["public.events", new Map<string, MaskRule>([["tenant", { t: "partial", keepEnd: 4 }]])],
]);

const f = (name: string, tableOid: number, columnAttnum: number): ResultField => ({
  name,
  tableOid,
  columnAttnum,
  dataTypeOid: 25,
});

// Security decisions are driven only by per-column provenance + the catalog; the
// masker no longer takes a "touched tables" hint (it was unreliable — views and
// schema-qualified refs slipped past it).
const run = (fields: ResultField[], rows: unknown[], masks: ColumnMasks = MASKS) =>
  maskResultSet({ rows, fields, columnMasks: masks, catalog: CATALOG, salt: "salt-A" });

describe("maskResultSet: no-op (regression pin)", () => {
  test("empty column_masks returns the SAME rows untouched", () => {
    const rows = [{ email: "ada@acme.io" }];
    const out = run([f("email", USERS, 2)], rows, new Map());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows).toBe(rows); // identity — true no-op
  });

  test("a query over unmasked plain tables passes unchanged", () => {
    const rows = [{ id: 10, total: 42 }];
    const out = run([f("id", ORDERS, 1), f("total", ORDERS, 3)], rows);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows).toBe(rows);
      expect(out.maskedColumns).toEqual([]);
    }
  });
});

describe("maskResultSet: masks resolvable base-table columns", () => {
  test("direct column is masked", () => {
    const out = run([f("email", USERS, 2)], [{ email: "ada@acme.io" }]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows[0]).toEqual({ email: "***" });
      expect(out.maskedColumns).toEqual(["public.users.email"]);
    }
  });

  test("aliased column is masked by output name (the name-match killer)", () => {
    // SELECT u.email AS contact -> field name "contact", provenance users.email
    const out = run([f("contact", USERS, 2)], [{ contact: "ada@acme.io" }]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ contact: "***" });
  });

  test("join masks only the masked table's column, leaves the other", () => {
    const out = run(
      [f("email", USERS, 2), f("total", ORDERS, 3)],
      [{ email: "ada@acme.io", total: 42 }],
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ email: "***", total: 42 });
  });

  test("NULL in a masked column stays NULL", () => {
    const out = run([f("email", USERS, 2)], [{ email: null }]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ email: null });
  });

  test("partition CHILD queried directly resolves to the parent's mask", () => {
    // SELECT tenant FROM events_a -> tableOid=events_a (child), topParent=events
    const out = run([f("tenant", EVENTS_A, 2)], [{ tenant: "a" }]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows[0]).toEqual({ tenant: "•" }); // partial keepEnd:4 on len-1 -> fully masked
      expect(out.maskedColumns).toEqual(["public.events.tenant"]);
    }
  });

  test("partition PARENT query masks via the parent oid", () => {
    const out = run([f("tenant", EVENTS, 2)], [{ tenant: "a" }]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ tenant: "•" });
  });
});

describe("maskResultSet: parametric rules apply with the column's type", () => {
  test("partial masks a text column, revealing only the kept window", () => {
    const out = run(
      [f("tenant", EVENTS, 2)],
      [{ tenant: "tenant-1234" }],
      new Map<string, Map<string, MaskRule>>([
        ["public.events", new Map<string, MaskRule>([["tenant", { t: "partial", keepEnd: 4 }]])],
      ]),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ tenant: "•••••••1234" });
  });

  test("generalize:year truncates a date column to Jan 1", () => {
    const out = run(
      [f("dob", PEOPLE, 2)],
      [{ dob: new Date("1994-07-23T00:00:00Z") }],
      new Map<string, Map<string, MaskRule>>([
        ["public.people", new Map<string, MaskRule>([["dob", { t: "generalize", granularity: "year" }]])],
      ]),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.rows[0] as { dob: Date }).dob.toISOString()).toBe("1994-01-01T00:00:00.000Z");
      expect(out.maskedColumns).toEqual(["public.people.dob"]);
    }
  });

  test("generalize:<width> buckets a numeric column", () => {
    const out = run(
      [f("salary", PEOPLE, 3)],
      [{ salary: 73500 }],
      new Map<string, Map<string, MaskRule>>([
        ["public.people", new Map<string, MaskRule>([["salary", { t: "generalize", granularity: 1000 }]])],
      ]),
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ salary: 73000 });
  });

  test("pseudonymize replaces a TEXT column ('S') with a realistic fake", () => {
    const out = run(
      [f("name", PEOPLE, 4)],
      [{ name: "Ada Lovelace" }],
      new Map<string, Map<string, MaskRule>>([
        ["public.people", new Map<string, MaskRule>([["name", { t: "pseudonymize", kind: "name" }]])],
      ]),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const masked = (out.rows[0] as { name: string }).name;
      expect(typeof masked).toBe("string");
      expect(masked).not.toBe("Ada Lovelace"); // never the original
      expect(masked.length).toBeGreaterThan(0);
      expect(out.maskedColumns).toEqual(["public.people.name"]);
    }
  });

  test("noise randomizes a NUMERIC column ('N'), staying numeric and bounded", () => {
    const out = run(
      [f("salary", PEOPLE, 3)],
      [{ salary: 50000 }],
      new Map<string, Map<string, MaskRule>>([
        ["public.people", new Map<string, MaskRule>([["salary", { t: "noise", ratio: 0.1 }]])],
      ]),
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const masked = (out.rows[0] as { salary: number }).salary;
      expect(typeof masked).toBe("number");
      expect(masked).toBeGreaterThanOrEqual(50000 * 0.9 - 1e-6);
      expect(masked).toBeLessThanOrEqual(50000 * 1.1 + 1e-6);
    }
  });
});

describe("maskResultSet: fail-closed on out-of-domain parametric rules", () => {
  test("partial on a NON-text column rejects (text-only)", () => {
    const out = run(
      [f("salary", PEOPLE, 3)],
      [{ salary: 73500 }],
      new Map<string, Map<string, MaskRule>>([
        ["public.people", new Map<string, MaskRule>([["salary", { t: "partial", keepEnd: 4 }]])],
      ]),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("text-only");
  });

  test("generalize:year on a NON-date column rejects", () => {
    const out = run(
      [f("salary", PEOPLE, 3)],
      [{ salary: 73500 }],
      new Map<string, Map<string, MaskRule>>([
        ["public.people", new Map<string, MaskRule>([["salary", { t: "generalize", granularity: "year" }]])],
      ]),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("date/timestamp");
  });

  test("numeric generalize on a date column rejects", () => {
    const out = run(
      [f("dob", PEOPLE, 2)],
      [{ dob: new Date("1994-07-23T00:00:00Z") }],
      new Map<string, Map<string, MaskRule>>([
        ["public.people", new Map<string, MaskRule>([["dob", { t: "generalize", granularity: 1000 }]])],
      ]),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("numeric");
  });

  test("pseudonymize on a NON-text column rejects (text-only)", () => {
    const out = run(
      [f("salary", PEOPLE, 3)], // 'N'
      [{ salary: 73500 }],
      new Map<string, Map<string, MaskRule>>([
        ["public.people", new Map<string, MaskRule>([["salary", { t: "pseudonymize", kind: "name" }]])],
      ]),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("text-only");
  });

  test("noise on a NON-numeric column rejects (numeric-only)", () => {
    const out = run(
      [f("name", PEOPLE, 4)], // 'S'
      [{ name: "Ada Lovelace" }],
      new Map<string, Map<string, MaskRule>>([
        ["public.people", new Map<string, MaskRule>([["name", { t: "noise", ratio: 0.1 }]])],
      ]),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("numeric");
  });

  test("a parametric rule on a column of UNPROVEN type rejects (fail-closed)", () => {
    // A bare table whose catalog entry resolved NO column types (older cache /
    // a catalog miss). category is undefined → a parametric rule must reject
    // rather than transform against an unproven type.
    const WIDGETS = 600;
    const catalog: Catalog = new Map([
      // columns present, columnTypes intentionally omitted (undefined category).
      [WIDGETS, rel("public", "widgets", "r", WIDGETS, { 1: "id", 2: "label" })],
    ]);
    const out = maskResultSet({
      rows: [{ label: "hello" }],
      fields: [f("label", WIDGETS, 2)],
      columnMasks: new Map<string, Map<string, MaskRule>>([
        ["public.widgets", new Map<string, MaskRule>([["label", { t: "partial", keepEnd: 2 }]])],
      ]),
      catalog,
      salt: "salt-A",
    });
    expect(out.ok).toBe(false);
  });
});

describe("maskResultSet: system-schema exemption", () => {
  test("information_schema view output is NOT rejected (schema discovery)", () => {
    // list_tables: SELECT table_schema, table_name FROM information_schema.tables
    const rows = [{ table_schema: "public", table_name: "users" }];
    const out = run(
      [f("table_schema", INFO_TABLES, 1), f("table_name", INFO_TABLES, 2)],
      rows,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows[0]).toEqual({ table_schema: "public", table_name: "users" });
      expect(out.maskedColumns).toEqual([]);
    }
  });
});

describe("maskResultSet: fail-closed rejects", () => {
  test("view output rejects (lineage unknown) when the project masks anything", () => {
    const out = run([f("email", USERS_V, 2)], [{ email: "ada@acme.io" }]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("view");
  });

  test("matview output rejects", () => {
    const out = run([f("email", USERS_MV, 2)], [{ email: "ada@acme.io" }]);
    expect(out.ok).toBe(false);
  });

  test("computed output (to_jsonb) rejects", () => {
    const out = run([f("to_jsonb", 0, 0)], [{ to_jsonb: { email: "ada" } }]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("computed");
  });

  test("computed output rejects EVEN over an unrelated table (fail-closed, no touched-table heuristic)", () => {
    // Was previously allowed via a touched-table gate; that gate let
    // to_jsonb(view) / to_jsonb(private.users) leak, so any computed output now
    // rejects when masking is on. Conservative but safe; loosen with AST lineage.
    const out = run([f("count", 0, 0)], [{ count: 2 }]);
    expect(out.ok).toBe(false);
  });

  test("unresolvable OID rejects (cache miss -> caller refreshes)", () => {
    const out = run([f("x", 999999, 1)], [{ x: 1 }]);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toContain("resolve");
      expect(out.retryable).toBe(true);
    }
  });

  test("missing field metadata on a masked-project query rejects", () => {
    const out = maskResultSet({
      rows: [{ email: "ada" }],
      fields: undefined,
      columnMasks: MASKS,
      catalog: CATALOG,
      salt: "s",
    });
    expect(out.ok).toBe(false);
  });
});
