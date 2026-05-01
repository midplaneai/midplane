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
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "fra" });
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
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "fra" });
    await listAuditQueries(ANOTHER_CUSTOMER_ID, { region: "fra" });
    const binds = handle.queries
      .map((q) => q.sql)
      .filter((s) => s.includes("SET LOCAL"));
    expect(binds[0]).toContain(VALID_CUSTOMER_ID);
    expect(binds[1]).toContain(ANOTHER_CUSTOMER_ID);
  });

  it("refuses non-ULID customer ids before any DB work", async () => {
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await expect(
      listAuditQueries("'; DROP TABLE customers;--", { region: "fra" }),
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
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "fra" });
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
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "fra" });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toContain("WHEN has_executed THEN 'ALLOWED'");
    expect(sel.sql).toContain("WHEN has_failed THEN 'FAILED'");
    expect(sel.sql).toContain("'DENIED'");
    expect(sel.sql).toContain("'STUCK'");
    expect(sel.sql).toContain("'PENDING'");
  });

  it("requests one extra row past pageSize for next-cursor detection", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "fra",
      pageSize: 50,
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql.toLowerCase()).toMatch(/limit\s+\$\d+/);
    expect(sel.params).toContain(51);
  });

  it("filters by region in the WHERE clause", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "iad" });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain("iad");
  });

  it("applies status IN-list when statuses are provided", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "fra",
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
      region: "fra",
      tenantId: "tenant_42",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain("tenant_42");
  });

  it("emits ILIKE clauses against sql_raw, fingerprint, and query_id for search", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "fra",
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
      region: "fra",
      cursor,
    });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain(cursor);
    expect(sel.sql).toContain("attempted_event_id <");
  });

  it("threads the now() cutoff into the STUCK threshold parameter", async () => {
    handle.setNextResult([]);
    const fixedNow = new Date("2026-04-30T12:00:30Z"); // 30s after a target last_ts
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "fra",
      now: () => fixedNow,
    });
    const sel = lastSelect(handle.queries);
    // Cutoff = now - 30s = 2026-04-30T12:00:00Z. Drizzle binds Date as a
    // Date object in params, so check by ISO equivalence.
    const stuckBind = sel.params.find(
      (p): p is Date => p instanceof Date,
    );
    expect(stuckBind).toBeDefined();
    expect(stuckBind!.toISOString()).toBe("2026-04-30T12:00:00.000Z");
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
      region: "fra",
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
        status: "ALLOWED",
      },
    ]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    const result = await listAuditQueries(VALID_CUSTOMER_ID, { region: "fra" });
    expect(result.nextCursor).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.status).toBe("ALLOWED");
  });
});

describe("readStaleness", () => {
  it("scopes to the customer's region and returns null when no cursor rows exist", async () => {
    handle.setNextResult([[null]]);
    const { readStaleness } = await import("../src/lib/audit.ts");
    const result = await readStaleness(VALID_CUSTOMER_ID, "fra");
    expect(result.lastIndexedAt).toBeNull();
    expect(result.staleMs).toBeNull();
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain(VALID_CUSTOMER_ID);
    expect(sel.params).toContain("fra");
  });

  it("computes staleMs deterministically from injected now()", async () => {
    const lastIndexedAt = new Date("2026-04-30T12:00:00Z");
    const now = () => new Date("2026-04-30T12:01:30Z");
    handle.setNextResult([[lastIndexedAt]]);
    const { readStaleness } = await import("../src/lib/audit.ts");
    const result = await readStaleness(VALID_CUSTOMER_ID, "fra", now);
    expect(result.staleMs).toBe(90_000);
  });

  it("does NOT wrap in a transaction (indexer_cursors has no RLS)", async () => {
    handle.setNextResult([[null]]);
    const { readStaleness } = await import("../src/lib/audit.ts");
    await readStaleness(VALID_CUSTOMER_ID, "fra");
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
