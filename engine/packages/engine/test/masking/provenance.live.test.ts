// Live-Postgres integration pin for the masker.
//
// Proves maskResultSet against REAL RowDescription provenance (the A1 linchpin):
// real Postgres reports view/matview/computed OIDs the way the synthetic unit
// tests assume, so the alias/join/partition cases actually mask and the
// view/computed cases actually reject.
//
// Gated on MASKING_LIVE_PG_DSN so normal CI (no database) skips it. Run with:
//   MASKING_LIVE_PG_DSN=postgres://postgres@127.0.0.1:55432/probe \
//     bun test packages/engine/test/masking/provenance.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { buildCatalog, type CatalogQueryFn } from "../../src/masking/catalog.ts";
import {
  maskResultSet,
  type ColumnMasks,
  type MaskOutcome,
} from "../../src/masking/mask-result-set.ts";
import type { MaskRule } from "../../src/masking/transforms.ts";
import type { ResultField } from "../../src/executor.ts";

const DSN = process.env.MASKING_LIVE_PG_DSN;
const d = DSN ? describe : describe.skip;

const MASKS: ColumnMasks = new Map([
  ["public.users", new Map([["email", "full-redact"], ["ssn", "consistent-hash"]] as const)],
  ["public.events", new Map<string, MaskRule>([["tenant", { t: "partial", keepEnd: 4 }]])],
  // Non-public schema — proves the masker keys on resolved schema.table, not on
  // the IR's schema-stripped touched-table names.
  ["private.users", new Map([["email", "full-redact"]] as const)],
]);

const SCHEMA = `
DROP MATERIALIZED VIEW IF EXISTS users_mv CASCADE;
DROP VIEW IF EXISTS users_v CASCADE;
DROP TABLE IF EXISTS orders, users, events CASCADE;
DROP SCHEMA IF EXISTS private CASCADE;
CREATE TABLE users (id int primary key, email text, ssn text);
CREATE TABLE orders (id int primary key, user_id int, total numeric);
CREATE VIEW users_v AS SELECT id, email FROM users;
CREATE MATERIALIZED VIEW users_mv AS SELECT id, email FROM users;
CREATE TABLE events (id int, tenant text) PARTITION BY LIST (tenant);
CREATE TABLE events_a PARTITION OF events FOR VALUES IN ('a');
CREATE SCHEMA private;
CREATE TABLE private.users (id int primary key, email text);
INSERT INTO users VALUES (1,'ada@acme.io','079-05-1120');
INSERT INTO orders VALUES (10,1,42);
INSERT INTO events VALUES (100,'a');
INSERT INTO private.users VALUES (1,'ada@private.io');
`;

d("masking: live-PG provenance", () => {
  let client: pg.Client;
  let queryFn: CatalogQueryFn;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    await client.query(SCHEMA);
    queryFn = (sql, params) => client.query(sql, params).then((r) => r.rows as Record<string, unknown>[]);
  });
  afterAll(async () => { if (client) await client.end(); });

  async function maskQuery(sql: string): Promise<MaskOutcome> {
    const res = await client.query(sql);
    const fields: ResultField[] = res.fields.map((f) => ({
      name: f.name,
      tableOid: f.tableID ?? 0,
      columnAttnum: f.columnID ?? 0,
      dataTypeOid: f.dataTypeID ?? 0,
    }));
    const catalog = await buildCatalog(queryFn, fields.map((f) => f.tableOid));
    return maskResultSet({
      rows: res.rows,
      fields,
      columnMasks: MASKS,
      catalog,
      salt: "salt-A",
    });
  }

  test("direct masked column is redacted", async () => {
    const out = await maskQuery("SELECT email FROM users");
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.rows[0] as any).email).toBe("***");
  });

  test("aliased masked column is redacted by its output name", async () => {
    const out = await maskQuery("SELECT u.email AS contact FROM users u");
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.rows[0] as any).contact).toBe("***");
  });

  test("SELECT * masks email + ssn, leaves id", async () => {
    const out = await maskQuery("SELECT * FROM users");
    expect(out.ok).toBe(true);
    if (out.ok) {
      const r = out.rows[0] as any;
      expect(r.email).toBe("***");
      expect(r.ssn).not.toBe("079-05-1120"); // consistent-hash, not plaintext
      expect(r.id).toBe(1);
    }
  });

  test("join masks the masked table's column, leaves the other table's", async () => {
    const out = await maskQuery(
      "SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id",
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      const r = out.rows[0] as any;
      expect(r.email).toBe("***");
      expect(Number(r.total)).toBe(42);
    }
  });

  test("inline-CTE pass-through still masks (provenance resolves to base)", async () => {
    const out = await maskQuery("WITH s AS (SELECT email FROM users) SELECT email FROM s");
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.rows[0] as any).email).toBe("***");
  });

  test("partition parent masks", async () => {
    const out = await maskQuery("SELECT tenant FROM events");
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.rows[0] as any).tenant).toBe("•"); // partial{keepEnd:4} on "a"
  });

  test("partition child queried directly masks via the parent", async () => {
    const out = await maskQuery("SELECT tenant FROM events_a");
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.rows[0] as any).tenant).toBe("•");
  });

  test("non-public schema: direct private.users.email is masked", async () => {
    const out = await maskQuery("SELECT email FROM private.users");
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.rows[0] as any).email).toBe("***");
  });

  // ── system-schema exemption (reviewer #1) ──────────────────────────────────
  test("information_schema discovery is NOT rejected with masking on", async () => {
    // The exact shape list_tables runs. Was rejected as a "view output".
    const out = await maskQuery(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    expect(out.ok).toBe(true);
  });

  test("describe_table (information_schema.columns) is NOT rejected", async () => {
    const out = await maskQuery(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='users'",
    );
    expect(out.ok).toBe(true);
  });

  // ── fail-closed rejects ─────────────────────────────────────────────────────
  test("view output REJECTS (the silent-leak hole)", async () => {
    const out = await maskQuery("SELECT email FROM users_v");
    expect(out.ok).toBe(false);
  });

  test("matview output REJECTS", async () => {
    const out = await maskQuery("SELECT email FROM users_mv");
    expect(out.ok).toBe(false);
  });

  test("whole-row to_jsonb REJECTS", async () => {
    const out = await maskQuery("SELECT to_jsonb(users) AS j FROM users");
    expect(out.ok).toBe(false);
  });

  // reviewer #2: schema-qualified computed leak — to_jsonb over a NON-public
  // masked table used to slip the touched-table gate (IR contributed "users").
  test("to_jsonb over a non-public masked table REJECTS (was the schema-qualified leak)", async () => {
    // FROM private.users has range alias "users"; to_jsonb(users) serializes the
    // whole row (incl. the masked email) as a computed output -> must reject.
    const out = await maskQuery("SELECT to_jsonb(u) AS j FROM private.users u");
    expect(out.ok).toBe(false);
  });

  // reviewer #2: computed over a VIEW used to slip the gate too.
  test("to_jsonb over a view REJECTS", async () => {
    const out = await maskQuery("SELECT to_jsonb(users_v) AS j FROM users_v");
    expect(out.ok).toBe(false);
  });

  test("UNION / set-op REJECTS", async () => {
    const out = await maskQuery("SELECT email FROM users UNION SELECT email FROM users");
    expect(out.ok).toBe(false);
  });

  test("aggregate over masked table REJECTS", async () => {
    const out = await maskQuery("SELECT count(*) FROM users");
    expect(out.ok).toBe(false);
  });

  test("computed output REJECTS even over an unrelated table (fail-closed)", async () => {
    // Was previously allowed via the touched-table gate; now any computed
    // output rejects when masking is on (no heuristic that views/schemas slip).
    const out = await maskQuery("SELECT count(*) FROM orders");
    expect(out.ok).toBe(false);
  });
});
