// Unit coverage for the audit query lib. Strategy: real Drizzle instance
// over a hand-rolled fake postgres-js Sql client. Drizzle compiles real
// SQL strings; the fake captures every `client.unsafe(sql, params)` call
// and every transaction's child client. We assert on:
//   1. SET LOCAL app.customer_id = '<id>' fires inside every transaction
//      (the RLS bind audit trail). The literal "SET LOCAL" must appear in
//      the executed SQL so reviewers + this test can grep for it.
//   2. The collapsed-by-query CTE is emitted with the new aggregations
//      (sql_raw, agent_name, agent_intent, exec_ms) and the terminal
//      status CASE.
//   3. status filter narrows via IN; tenant_id via eq; search against
//      payload->>'sql_raw' OR sql_fingerprint OR query_id (ILIKE).
//   4. Cursor pagination uses attempted_event_id < $cursor (DESC paging).
//   5. STUCK detection fires off the injected now() so the threshold is
//      deterministic.
//   6. Invalid customer_id (not a ULID) refuses to bind RLS at all.
//
// What this does NOT cover: real Postgres aggregation correctness (the
// terminal-status CASE picks the right state given a real lifecycle
// sequence). That's the Playwright e2e in audit-isolation.e2e.ts.

import { drizzle } from "drizzle-orm/postgres-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@midplane-cloud/db";

interface RecordedQuery {
  sql: string;
  params: unknown[];
  /** Whether the call came from inside a transaction's child client. */
  inTransaction: boolean;
}
interface FakeHandle {
  db: ReturnType<typeof drizzle>;
  queries: RecordedQuery[];
  /** Loose by design: column-decoded SELECTs use tuples; raw `tx.execute()`
   *  paths return row objects. Tests pass whichever shape matches the call
   *  site they're exercising. */
  setNextResult(rows: unknown[][] | Record<string, unknown>[]): void;
}

let handle: FakeHandle;

function makeFakeDb(): FakeHandle {
  const queries: RecordedQuery[] = [];
  let nextResult: unknown = [];

  const makeClient = (inTransaction: boolean): FakeSql => {
    const unsafe = (sql: string, params: unknown[]) => {
      queries.push({ sql, params, inTransaction });
      const rows = nextResult;
      // Default thenable: .values() returns raw arrays, .then resolves rows.
      // The new listAuditQueries path goes through tx.execute(sql) which
      // resolves via .then directly on the client return; the legacy
      // selectFrom path uses .values(). Both are stubbed.
      const thenable: PromiseLike<unknown> & {
        values: () => Promise<unknown>;
        then: PromiseLike<unknown>["then"];
      } = {
        values: () => Promise.resolve(rows),
        then: (onF, onR) => Promise.resolve(rows).then(onF as never, onR),
      };
      return thenable;
    };
    const begin = async (cb: (tx: FakeSql) => Promise<unknown>) => {
      return cb(makeClient(true));
    };
    return {
      unsafe,
      begin,
      // postgres-js Sql instances expose .options.parsers/serializers; the
      // Drizzle driver reads them at construct time.
      options: { parsers: {}, serializers: {} },
    } as FakeSql;
  };

  const sql = makeClient(false);
  // The fake doesn't satisfy postgres-js Sql in full; cast through unknown.
  // drizzle() will only call .unsafe / .begin / .options on it.
  const db = drizzle(sql as never, { schema });

  return {
    db,
    queries,
    setNextResult(rows) {
      nextResult = rows;
    },
  };
}

interface FakeSql {
  unsafe: (sql: string, params: unknown[]) => unknown;
  begin: (cb: (tx: FakeSql) => Promise<unknown>) => Promise<unknown>;
  options: { parsers: Record<string, unknown>; serializers: Record<string, unknown> };
}

vi.mock("@midplane-cloud/db", async (orig) => {
  const real = (await orig()) as typeof import("@midplane-cloud/db");
  return {
    ...real,
    getDb: () => handle.db,
  };
});

beforeEach(() => {
  handle = makeFakeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

const VALID_CUSTOMER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ANOTHER_CUSTOMER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FBW";

describe("RLS bind", () => {
  it("emits SET LOCAL app.customer_id with the bound id on every list", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    const setLocal = handle.queries.find((q) =>
      q.sql.includes("SET LOCAL app.customer_id"),
    );
    expect(setLocal, "SET LOCAL must run inside the txn").toBeDefined();
    expect(setLocal!.sql).toContain(`'${VALID_CUSTOMER_ID}'`);
    expect(setLocal!.inTransaction).toBe(true);
  });

  it("uses a fresh bind per customer (no leakage)", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    await listAuditQueries(ANOTHER_CUSTOMER_ID, { region: "eu" });
    const binds = handle.queries
      .map((q) => q.sql)
      .filter((s) => s.includes("SET LOCAL"));
    expect(binds[0]).toContain(VALID_CUSTOMER_ID);
    expect(binds[1]).toContain(ANOTHER_CUSTOMER_ID);
  });

  it("refuses non-ULID customer ids before any DB work", async () => {
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await expect(
      listAuditQueries("'; DROP TABLE customers;--", { region: "eu" }),
    ).rejects.toThrow(/ULID/);
    expect(handle.queries).toHaveLength(0);
  });

  it("also binds RLS for getAuditEvent and getRelatedEvents", async () => {
    handle.setNextResult([]);
    const { getAuditEvent, getRelatedEvents } = await import(
      "../src/lib/audit.ts"
    );
    await getAuditEvent(VALID_CUSTOMER_ID, "01ARZ3NDEKTSV4RRFFQ69G5FCC");
    await getRelatedEvents(VALID_CUSTOMER_ID, "q-123");
    const binds = handle.queries.filter((q) =>
      q.sql.includes("SET LOCAL app.customer_id"),
    );
    expect(binds.length).toBeGreaterThanOrEqual(2);
  });
});

describe("listAuditQueries query shape", () => {
  it("emits a CTE that aggregates one row per query_id", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toContain("GROUP BY query_id");
    // Aggregations the UI reads off the row.
    expect(sel.sql).toContain("MIN(id) AS attempted_event_id");
    expect(sel.sql).toContain("MAX(id) AS head_event_id");
    expect(sel.sql).toContain("MAX(agent_name) AS agent_name");
    expect(sel.sql).toContain("MAX(agent_intent) AS agent_intent");
    expect(sel.sql).toContain("payload ->> 'sql_raw'");
    expect(sel.sql).toContain("(payload ->> 'exec_ms')::numeric");
  });

  it("emits a status CASE that classifies each lifecycle into a terminal state", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toContain("WHEN has_executed THEN 'ALLOWED'");
    expect(sel.sql).toContain("WHEN has_failed THEN 'FAILED'");
    expect(sel.sql).toContain("'DENIED'");
    expect(sel.sql).toContain("'STUCK'");
    expect(sel.sql).toContain("'PENDING'");
  });

  it("UNIONs POLICY_RELOADED rows so operators can verify hot-swaps from the audit log", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    const sel = lastSelect(handle.queries);
    // The query collapses queries into one row each AND keeps policy
    // events visible — they have no query_id and no SQL but are operator-
    // facing, so they can't silently disappear from the list.
    expect(sel.sql).toContain("policy_events");
    expect(sel.sql).toContain("'POLICY_RELOADED'");
    expect(sel.sql).toContain("'POLICY_RELOAD'");
    expect(sel.sql.toLowerCase()).toContain("union all");
  });

  it("excludes policy events when search is active (no SQL to match against)", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      search: "users",
    });
    const sel = lastSelect(handle.queries);
    // policySearchClause flips to AND FALSE so a "DELETE FROM users"
    // search doesn't surface unrelated reload rows.
    expect(sel.sql).toContain("AND FALSE");
  });

  it("returns POLICY_RELOAD rows with null queryId, null SQL, and the OSS 0.5.0 structured payload", async () => {
    // OSS 0.5.0 wire shape: tenant_scope diff carries column.{from,to},
    // overrides_{added,removed,changed}, and exempt_{added,removed}.
    // The 0.4.0 `mappings_*` keys are gone from new writes; the renderer
    // still falls back to them so historical audit rows keep working.
    const policyPayload = {
      sections_changed: ["tenant_scope"],
      databases_changed: ["main"],
      tenant_scope: {
        column: "tenant_id",
        overrides: { orders: "org_id" },
        exempt: ["audit_log"],
      },
      diffs: {
        main: {
          tenant_scope: {
            column: { from: null, to: "tenant_id" },
            overrides_added: { orders: "org_id" },
            overrides_removed: {},
            overrides_changed: {},
            exempt_added: ["audit_log"],
            exempt_removed: [],
          },
        },
      },
    };
    handle.setNextResult([
      {
        query_id: null,
        attempted_event_id: "01HXPOLICYRELOAD00000000000",
        head_event_id: "01HXPOLICYRELOAD00000000000",
        started_at: new Date("2026-04-30T12:00:00Z"),
        last_ts: new Date("2026-04-30T12:00:00Z"),
        tenant_id: "__self_host__",
        database: "main",
        agent_name: null,
        agent_version: null,
        agent_intent: null,
        intent_source: null,
        sql_raw: null,
        sql_fingerprint: null,
        decision: null,
        decision_reason: null,
        exec_ms: null,
        policy_payload: policyPayload,
        status: "POLICY_RELOAD",
      },
    ]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    const result = await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.queryId).toBeNull();
    expect(result.rows[0]!.status).toBe("POLICY_RELOAD");
    expect(result.rows[0]!.sqlRaw).toBeNull();
    // The 0.4.0 payload shape lands as a structured object so the list
    // view can render "tenant_scope updated on main" without a second
    // round trip. Backwards-compat for older rows is covered by the
    // separate legacy fixture below.
    expect(result.rows[0]!.policyPayload).toEqual(policyPayload);
  });

  it("renders pre-0.4.0 POLICY_RELOAD rows with a null payload (no crash, generic label fallback)", async () => {
    // Older indexer fills audit_events_index with a flat or empty payload.
    // The list lib normalizes anything non-object to null so the renderer
    // falls through to the generic ARIA label.
    handle.setNextResult([
      {
        query_id: null,
        attempted_event_id: "01HXPOLICYLEGACY0000000000",
        head_event_id: "01HXPOLICYLEGACY0000000000",
        started_at: new Date("2026-04-29T12:00:00Z"),
        last_ts: new Date("2026-04-29T12:00:00Z"),
        tenant_id: "__self_host__",
        database: "main",
        agent_name: null,
        agent_version: null,
        agent_intent: null,
        intent_source: null,
        sql_raw: null,
        sql_fingerprint: null,
        decision: null,
        decision_reason: null,
        exec_ms: null,
        policy_payload: null,
        status: "POLICY_RELOAD",
      },
    ]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    const result = await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.policyPayload).toBeNull();
  });

  it("projects the policy event payload column so the list renderer can pick up sections_changed", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    const sel = lastSelect(handle.queries);
    // The CTE must project payload AS policy_payload for POLICY_RELOAD
    // rows AND a NULL placeholder for the classified branch so UNION ALL
    // matches column types. Without this, the renderer can't surface
    // "tenant_scope updated on main" — it would land on the generic label
    // for every row.
    expect(sel.sql).toContain("policy_payload");
    expect(sel.sql).toContain("NULL::jsonb AS policy_payload");
  });

  it("requests one extra row past pageSize for next-cursor detection", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      pageSize: 50,
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql.toLowerCase()).toMatch(/limit\s+\$\d+/);
    expect(sel.params).toContain(51);
  });

  it("filters by region in the WHERE clause", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "us" });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain("us");
  });

  it("applies status IN-list when statuses are provided", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      statuses: ["DENIED", "FAILED"],
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toMatch(/status IN \(/);
    expect(sel.params).toContain("DENIED");
    expect(sel.params).toContain("FAILED");
  });

  it("applies tenant_id filter when present", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      tenantId: "tenant_42",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain("tenant_42");
  });

  it("applies database filter when present (the per-DB connection child)", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      database: "analytics",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toContain("database");
    expect(sel.params).toContain("analytics");
  });

  it("emits ILIKE clauses against sql_raw, fingerprint, and query_id for search", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      search: "users",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql.toLowerCase()).toContain("ilike");
    expect(sel.sql).toContain("sql_raw");
    expect(sel.sql).toContain("sql_fingerprint");
    expect(sel.params).toContain("%users%");
  });

  it("uses cursor in WHERE when provided (attempted_event_id < cursor for DESC paging)", async () => {
    handle.setNextResult([]);
    const cursor = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      cursor,
    });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain(cursor);
    expect(sel.sql).toContain("attempted_event_id <");
  });

  it("threads the now() cutoff into the STUCK threshold as ISO text + ::timestamptz cast", async () => {
    handle.setNextResult([]);
    const fixedNow = new Date("2026-04-30T12:00:30Z"); // 30s after a target last_ts
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      now: () => fixedNow,
    });
    const sel = lastSelect(handle.queries);
    // Cutoff = now - 30s = 2026-04-30T12:00:00Z, sent as ISO text. A bare
    // Date here would 500 at runtime — postgres-js's raw-unsafe parameter
    // codec rejects Date with "argument must be string or Buffer". Guard
    // the shape so the regression can't reappear silently.
    const dateParam = sel.params.find((p) => p instanceof Date);
    expect(dateParam, "no Date should reach the unsafe codec").toBeUndefined();
    expect(sel.params).toContain("2026-04-30T12:00:00.000Z");
    expect(sel.sql).toContain("::timestamptz");
  });

  it("computes nextCursor when pageSize+1 rows are returned", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      query_id: `q-${50 - i}`,
      attempted_event_id: `att-${50 - i}`,
      head_event_id: `head-${50 - i}`,
      started_at: new Date(),
      last_ts: new Date(),
      tenant_id: "t",
      database: "main",
      agent_name: null,
      agent_version: null,
      agent_intent: null,
      intent_source: null,
      sql_raw: null,
      sql_fingerprint: null,
      decision: null,
      decision_reason: null,
      exec_ms: null,
      has_attempted: true,
      has_decided: false,
      has_executed: false,
      has_failed: false,
      status: "PENDING",
    }));
    handle.setNextResult(rows);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    const result = await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      pageSize: 50,
    });
    expect(result.rows).toHaveLength(50);
    expect(result.nextCursor).toBe("att-1");
  });

  it("returns nextCursor=null when fewer than pageSize+1 rows are returned", async () => {
    handle.setNextResult([
      {
        query_id: "q-only",
        attempted_event_id: "att-only",
        head_event_id: "head-only",
        started_at: new Date(),
        last_ts: new Date(),
        tenant_id: "t",
        database: "main",
        agent_name: null,
        agent_version: null,
        agent_intent: null,
        intent_source: null,
        sql_raw: null,
        sql_fingerprint: null,
        decision: null,
        decision_reason: null,
        exec_ms: null,
        policy_payload: null,
        status: "ALLOWED",
      },
    ]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    const result = await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    expect(result.nextCursor).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.status).toBe("ALLOWED");
  });
});

describe("listDatabases", () => {
  it("selects distinct database under RLS bind", async () => {
    handle.setNextResult([["analytics"], ["main"]]);
    const { listDatabases } = await import("../src/lib/audit.ts");
    const result = await listDatabases(VALID_CUSTOMER_ID, "eu");
    expect(result).toEqual(["analytics", "main"]);
    const sel = lastSelect(handle.queries);
    expect(sel.sql.toLowerCase()).toContain("distinct");
    expect(sel.sql).toContain("database");
    expect(sel.params).toContain(VALID_CUSTOMER_ID);
    expect(sel.params).toContain("eu");
    expect(sel.inTransaction).toBe(true);
  });

  it("orders by database asc BEFORE the LIMIT (deterministic >50 rows)", async () => {
    handle.setNextResult([]);
    const { listDatabases } = await import("../src/lib/audit.ts");
    await listDatabases(VALID_CUSTOMER_ID, "eu");
    const sel = lastSelect(handle.queries);
    const lower = sel.sql.toLowerCase();
    const orderIdx = lower.indexOf("order by");
    const limitIdx = lower.indexOf("limit");
    expect(orderIdx, "ORDER BY must be present").toBeGreaterThan(-1);
    expect(limitIdx, "LIMIT must be present").toBeGreaterThan(-1);
    expect(orderIdx, "ORDER BY must precede LIMIT").toBeLessThan(limitIdx);
    expect(sel.params).toContain(50);
  });
});

describe("listTenantIds", () => {
  it("orders by tenant_id asc BEFORE the LIMIT (deterministic >50 rows)", async () => {
    handle.setNextResult([]);
    const { listTenantIds } = await import("../src/lib/audit.ts");
    await listTenantIds(VALID_CUSTOMER_ID, "eu");
    const sel = lastSelect(handle.queries);
    const lower = sel.sql.toLowerCase();
    const orderIdx = lower.indexOf("order by");
    const limitIdx = lower.indexOf("limit");
    expect(orderIdx).toBeGreaterThan(-1);
    expect(limitIdx).toBeGreaterThan(-1);
    expect(orderIdx).toBeLessThan(limitIdx);
  });
});

describe("eventVolumeByHour", () => {
  it("returns exactly `hours` zero-filled buckets aligned to the hour", async () => {
    handle.setNextResult([]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    const now = () => new Date("2026-04-30T12:34:56Z");
    const buckets = await eventVolumeByHour(VALID_CUSTOMER_ID, "eu", {
      hours: 24,
      now,
    });
    expect(buckets).toHaveLength(24);
    expect(buckets[buckets.length - 1]!.ts.toISOString()).toBe(
      "2026-04-30T12:00:00.000Z",
    );
    expect(buckets[0]!.ts.toISOString()).toBe("2026-04-29T13:00:00.000Z");
    for (const b of buckets) {
      expect(b.counts).toEqual({});
    }
  });

  it("merges per-terminal-status rows into the matching bucket", async () => {
    handle.setNextResult([
      { bucket: new Date("2026-04-30T11:00:00Z"), terminal: "denied", count: 3 },
      { bucket: new Date("2026-04-30T11:00:00Z"), terminal: "failed", count: 1 },
      { bucket: new Date("2026-04-30T12:00:00Z"), terminal: "executed", count: 7 },
    ]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    const now = () => new Date("2026-04-30T12:30:00Z");
    const buckets = await eventVolumeByHour(VALID_CUSTOMER_ID, "eu", {
      hours: 24,
      now,
    });
    const last = buckets[buckets.length - 1]!;
    const prior = buckets[buckets.length - 2]!;
    expect(last.counts).toEqual({ executed: 7 });
    expect(prior.counts).toEqual({ denied: 3, failed: 1 });
  });

  it("ignores unknown terminal values from the SQL CASE", async () => {
    handle.setNextResult([
      { bucket: new Date("2026-04-30T12:00:00Z"), terminal: "wat", count: 9 },
    ]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    const now = () => new Date("2026-04-30T12:30:00Z");
    const buckets = await eventVolumeByHour(VALID_CUSTOMER_ID, "eu", {
      hours: 24,
      now,
    });
    expect(buckets[buckets.length - 1]!.counts).toEqual({});
  });

  it("sends the time boundary as ISO text, not a Date (postgres-js raw-unsafe codec rejects Date)", async () => {
    handle.setNextResult([]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    const now = () => new Date("2026-04-30T12:30:00Z");
    await eventVolumeByHour(VALID_CUSTOMER_ID, "eu", { hours: 24, now });
    const sel = lastSelect(handle.queries);
    const dateParam = sel.params.find((p) => p instanceof Date);
    expect(dateParam, "no Date should reach the unsafe codec").toBeUndefined();
    expect(sel.params).toContain("2026-04-29T13:00:00.000Z");
    expect(sel.sql).toContain("::timestamptz");
  });

  it("threads tenantId / database / search filters into the volume query (matches table filters)", async () => {
    handle.setNextResult([]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    await eventVolumeByHour(VALID_CUSTOMER_ID, "eu", {
      tenantId: "tenant_42",
      database: "analytics",
      search: "users",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toContain("tenant_id");
    expect(sel.params).toContain("tenant_42");
    expect(sel.sql).toContain("database");
    expect(sel.params).toContain("analytics");
    // Search lifts via a query_id IN (...) subquery so the chart matches
    // exactly what the listing's search shows.
    expect(sel.sql.toLowerCase()).toContain("query_id in (");
    expect(sel.sql.toLowerCase()).toContain("ilike");
    expect(sel.params).toContain("%users%");
  });

  it("omits filter clauses when none are passed (no spurious AND fragments)", async () => {
    handle.setNextResult([]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    await eventVolumeByHour(VALID_CUSTOMER_ID, "eu");
    const sel = lastSelect(handle.queries);
    expect(sel.sql).not.toContain("tenant_id =");
    expect(sel.sql).not.toContain("database =");
    expect(sel.sql.toLowerCase()).not.toContain("query_id in (");
  });

  it("scopes the volume query under the RLS bind, dedupes per query_id, treats deny-only DECIDED as terminal", async () => {
    handle.setNextResult([]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    await eventVolumeByHour(VALID_CUSTOMER_ID, "eu");
    const sel = lastSelect(handle.queries);
    expect(sel.inTransaction).toBe(true);
    const lower = sel.sql.toLowerCase();
    expect(lower).toContain("date_trunc");
    expect(lower).toContain("distinct on (query_id)");
    expect(lower).toContain("group by 1, 2");
    // DECIDED-allow rows must be filtered out so they don't shadow the
    // matching EXECUTED row for the same query under DISTINCT ON precedence.
    expect(sel.sql).toContain("'decision'");
    expect(sel.sql).toContain("'deny'");
    expect(sel.sql).toContain("'EXECUTED'");
    expect(sel.sql).toContain("'FAILED'");
    // OSS 0.3.0 emits "DENY" (uppercase) in the decision payload, so the
    // filter must lower() before comparing — without this the sparkline
    // silently drops every denied query while the chip count and table
    // row both show it (the other two paths already lowercase). Guard
    // here so a future "simplification" can't regress to case-sensitive.
    expect(sel.sql.toLowerCase()).toContain("lower(payload ->> 'decision')");
  });
});

describe("readStaleness", () => {
  it("scopes to the customer's region and returns null when no cursor rows exist", async () => {
    handle.setNextResult([[null]]);
    const { readStaleness } = await import("../src/lib/audit.ts");
    const result = await readStaleness(VALID_CUSTOMER_ID, "eu");
    expect(result.lastIndexedAt).toBeNull();
    expect(result.staleMs).toBeNull();
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain(VALID_CUSTOMER_ID);
    expect(sel.params).toContain("eu");
  });

  it("computes staleMs deterministically from injected now()", async () => {
    const lastIndexedAt = new Date("2026-04-30T12:00:00Z");
    const now = () => new Date("2026-04-30T12:01:30Z");
    handle.setNextResult([[lastIndexedAt]]);
    const { readStaleness } = await import("../src/lib/audit.ts");
    const result = await readStaleness(VALID_CUSTOMER_ID, "eu", now);
    expect(result.staleMs).toBe(90_000);
  });

  it("does NOT wrap in a transaction (indexer_cursors has no RLS)", async () => {
    handle.setNextResult([[null]]);
    const { readStaleness } = await import("../src/lib/audit.ts");
    await readStaleness(VALID_CUSTOMER_ID, "eu");
    const txCalls = handle.queries.filter((q) => q.inTransaction);
    expect(txCalls).toHaveLength(0);
  });
});

function lastSelect(queries: RecordedQuery[]): RecordedQuery {
  // Skip the SET LOCAL bind; return the actual data query.
  const data = queries.filter((q) => !q.sql.includes("SET LOCAL"));
  const last = data[data.length - 1];
  if (!last) throw new Error("no data query was recorded");
  return last;
}
