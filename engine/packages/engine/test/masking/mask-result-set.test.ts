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
import type { ResultField } from "../../src/executor.ts";

// OIDs mirror the provenance-probe schema shape.
const USERS = 100, ORDERS = 200, USERS_V = 300, USERS_MV = 350, EVENTS = 400, EVENTS_A = 401;

const rel = (
  schema: string,
  relname: string,
  relkind: string,
  topParentOid: number,
  cols: Record<number, string>,
): RelInfo => ({
  schema,
  relname,
  relkind,
  topParentOid,
  columns: new Map(Object.entries(cols).map(([k, v]) => [Number(k), v])),
});

const CATALOG: Catalog = new Map([
  [USERS, rel("public", "users", "r", USERS, { 1: "id", 2: "email", 3: "ssn" })],
  [ORDERS, rel("public", "orders", "r", ORDERS, { 1: "id", 2: "user_id", 3: "total" })],
  [USERS_V, rel("public", "users_v", "v", USERS_V, { 1: "id", 2: "email" })],
  [USERS_MV, rel("public", "users_mv", "m", USERS_MV, { 1: "id", 2: "email" })],
  [EVENTS, rel("public", "events", "p", EVENTS, { 1: "id", 2: "tenant" })],
  [EVENTS_A, rel("public", "events_a", "r", EVENTS, { 1: "id", 2: "tenant" })], // child -> parent EVENTS
]);

const MASKS: ColumnMasks = new Map([
  ["public.users", new Map([["email", "full-redact"], ["ssn", "consistent-hash"]] as const)],
  ["public.events", new Map([["tenant", "keep-last-4"]] as const)],
]);

const f = (name: string, tableOid: number, columnAttnum: number): ResultField => ({
  name,
  tableOid,
  columnAttnum,
  dataTypeOid: 25,
});

const run = (fields: ResultField[], rows: unknown[], touched: string[], masks = MASKS) =>
  maskResultSet({
    rows,
    fields,
    columnMasks: masks,
    catalog: CATALOG,
    touchedTables: new Set(touched),
    salt: "salt-A",
  });

describe("maskResultSet: no-op (regression pin)", () => {
  test("empty column_masks returns the SAME rows untouched", () => {
    const rows = [{ email: "ada@acme.io" }];
    const out = run([f("email", USERS, 2)], rows, ["public.users"], new Map());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows).toBe(rows); // identity — true no-op
  });

  test("a query touching only unmasked plain tables passes unchanged", () => {
    const rows = [{ id: 10, total: 42 }];
    const out = run([f("id", ORDERS, 1), f("total", ORDERS, 3)], rows, ["public.orders"]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows).toBe(rows);
      expect(out.maskedColumns).toEqual([]);
    }
  });
});

describe("maskResultSet: masks resolvable base-table columns", () => {
  test("direct column is masked", () => {
    const out = run([f("email", USERS, 2)], [{ email: "ada@acme.io" }], ["public.users"]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.rows[0]).toEqual({ email: "***" });
      expect(out.maskedColumns).toEqual(["public.users.email"]);
    }
  });

  test("aliased column is masked by output name (the name-match killer)", () => {
    // SELECT u.email AS contact -> field name "contact", provenance users.email
    const out = run([f("contact", USERS, 2)], [{ contact: "ada@acme.io" }], ["public.users"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ contact: "***" });
  });

  test("join masks only the masked table's column, leaves the other", () => {
    const out = run(
      [f("email", USERS, 2), f("total", ORDERS, 3)],
      [{ email: "ada@acme.io", total: 42 }],
      ["public.users", "public.orders"],
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ email: "***", total: 42 });
  });

  test("NULL in a masked column stays NULL", () => {
    const out = run([f("email", USERS, 2)], [{ email: null }], ["public.users"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ email: null });
  });

  test("partition CHILD queried directly resolves to the parent's mask", () => {
    // SELECT tenant FROM events_a -> tableOid=events_a (child), topParent=events
    const out = run([f("tenant", EVENTS_A, 2)], [{ tenant: "a" }], ["public.events_a"]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      // keep-last-4 on "a" (len 1) -> fully masked
      expect(out.rows[0]).toEqual({ tenant: "•" });
      expect(out.maskedColumns).toEqual(["public.events.tenant"]);
    }
  });

  test("partition PARENT query masks via the parent oid", () => {
    const out = run([f("tenant", EVENTS, 2)], [{ tenant: "a" }], ["public.events"]);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.rows[0]).toEqual({ tenant: "•" });
  });
});

describe("maskResultSet: fail-closed rejects", () => {
  test("view output rejects (lineage unknown) when the project masks anything", () => {
    const out = run([f("email", USERS_V, 2)], [{ email: "ada@acme.io" }], ["public.users_v"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("view");
  });

  test("matview output rejects", () => {
    const out = run([f("email", USERS_MV, 2)], [{ email: "ada@acme.io" }], ["public.users_mv"]);
    expect(out.ok).toBe(false);
  });

  test("computed output over a masked table rejects", () => {
    const out = run([f("to_jsonb", 0, 0)], [{ to_jsonb: { email: "ada" } }], ["public.users"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("computed");
  });

  test("computed output over an UNRELATED table passes (count over orders)", () => {
    const out = run([f("count", 0, 0)], [{ count: 2 }], ["public.orders"]);
    expect(out.ok).toBe(true); // touches no masked table -> safe
  });

  test("unresolvable OID rejects (cache miss -> caller refreshes)", () => {
    const out = run([f("x", 999999, 1)], [{ x: 1 }], ["public.users"]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("resolve");
  });

  test("missing field metadata on a masked-project query rejects", () => {
    const out = maskResultSet({
      rows: [{ email: "ada" }],
      fields: undefined,
      columnMasks: MASKS,
      catalog: CATALOG,
      touchedTables: new Set(["public.users"]),
      salt: "s",
    });
    expect(out.ok).toBe(false);
  });
});
