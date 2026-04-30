// Unit coverage for the audit query lib. Strategy: real Drizzle instance
// over a hand-rolled fake postgres-js Sql client. Drizzle compiles real
// SQL strings; the fake captures every `client.unsafe(sql, params)` call
// and every transaction's child client. We assert on:
//   1. SET LOCAL app.customer_id = '<id>' fires inside every transaction
//      (the RLS bind audit trail). The literal "SET LOCAL" must appear in
//      the executed SQL so reviewers + this test can grep for it.
//   2. The cursor pagination clause is emitted (id < cursor + LIMIT 51).
//   3. event_type filter narrows via inArray; tenant_id via eq; search
//      against payload->>'sql_fingerprint' and query_id (ILIKE).
//   4. Invalid customer_id (not a ULID) refuses to bind RLS at all.
//
// What this does NOT cover: real Postgres RLS behavior (gated cross-tenant
// reads). That's the Playwright e2e in audit-isolation.e2e.ts.

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
  setNextResult(rows: unknown[][]): void;
}

let handle: FakeHandle;

function makeFakeDb(): FakeHandle {
  const queries: RecordedQuery[] = [];
  let nextResult: unknown[][] = [];

  const makeClient = (inTransaction: boolean): FakeSql => {
    const unsafe = (sql: string, params: unknown[]) => {
      queries.push({ sql, params, inTransaction });
      const rows = nextResult;
      // Default thenable: .values() returns raw arrays, .then resolves rows
      // (Drizzle uses .values() for SELECTs that go through prepareQuery,
      // and bare .then for ad-hoc client.unsafe in the session.execute path).
      const thenable: PromiseLike<unknown> & {
        values: () => Promise<unknown[][]>;
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
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    await listAuditEvents(VALID_CUSTOMER_ID, { region: "fra" });
    const setLocal = handle.queries.find((q) =>
      q.sql.includes("SET LOCAL app.customer_id"),
    );
    expect(setLocal, "SET LOCAL must run inside the txn").toBeDefined();
    expect(setLocal!.sql).toContain(`'${VALID_CUSTOMER_ID}'`);
    expect(setLocal!.inTransaction).toBe(true);
  });

  it("uses a fresh bind per customer (no leakage)", async () => {
    handle.setNextResult([]);
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    await listAuditEvents(VALID_CUSTOMER_ID, { region: "fra" });
    await listAuditEvents(ANOTHER_CUSTOMER_ID, { region: "fra" });
    const binds = handle.queries
      .map((q) => q.sql)
      .filter((s) => s.includes("SET LOCAL"));
    expect(binds[0]).toContain(VALID_CUSTOMER_ID);
    expect(binds[1]).toContain(ANOTHER_CUSTOMER_ID);
  });

  it("refuses non-ULID customer ids before any DB work", async () => {
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    await expect(
      listAuditEvents("'; DROP TABLE customers;--", { region: "fra" }),
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

describe("listAuditEvents query shape", () => {
  it("requests one extra row past pageSize for next-cursor detection", async () => {
    handle.setNextResult([]);
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    await listAuditEvents(VALID_CUSTOMER_ID, { region: "fra", pageSize: 50 });
    const sel = lastSelect(handle.queries);
    expect(sel.sql.toLowerCase()).toMatch(/limit\s+\$\d+/);
    expect(sel.params).toContain(51);
  });

  it("filters by region in the WHERE clause", async () => {
    handle.setNextResult([]);
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    await listAuditEvents(VALID_CUSTOMER_ID, { region: "iad" });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain("iad");
  });

  it("applies inArray for multiple event_types", async () => {
    handle.setNextResult([]);
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    await listAuditEvents(VALID_CUSTOMER_ID, {
      region: "fra",
      eventTypes: ["DECIDED", "FAILED"],
    });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain("DECIDED");
    expect(sel.params).toContain("FAILED");
  });

  it("applies tenant_id filter when present", async () => {
    handle.setNextResult([]);
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    await listAuditEvents(VALID_CUSTOMER_ID, {
      region: "fra",
      tenantId: "tenant_42",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain("tenant_42");
  });

  it("emits ILIKE clauses against fingerprint and query_id for search", async () => {
    handle.setNextResult([]);
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    await listAuditEvents(VALID_CUSTOMER_ID, {
      region: "fra",
      search: "users",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql.toLowerCase()).toContain("ilike");
    expect(sel.sql).toContain("sql_fingerprint");
    expect(sel.params).toContain("%users%");
  });

  it("uses cursor in WHERE when provided (id < cursor for DESC paging)", async () => {
    handle.setNextResult([]);
    const cursor = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    await listAuditEvents(VALID_CUSTOMER_ID, {
      region: "fra",
      cursor,
    });
    const sel = lastSelect(handle.queries);
    expect(sel.params).toContain(cursor);
    expect(sel.sql).toMatch(/<\s*\$\d+/);
  });

  it("computes nextCursor when pageSize+1 rows are returned", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => [
      `row-${50 - i}`, // id (DESC)
      new Date(), // ts
      "DECIDED", // eventType
      null, // agentIdentity
      "q", // queryId
      "t", // tenantId
      null, // sqlFingerprint
    ]);
    handle.setNextResult(rows);
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    const result = await listAuditEvents(VALID_CUSTOMER_ID, {
      region: "fra",
      pageSize: 50,
    });
    expect(result.rows).toHaveLength(50);
    expect(result.nextCursor).toBe("row-1");
  });

  it("returns nextCursor=null when fewer than pageSize+1 rows are returned", async () => {
    handle.setNextResult([
      ["only", new Date(), "EXECUTED", null, "q", "t", null],
    ]);
    const { listAuditEvents } = await import("../src/lib/audit.ts");
    const result = await listAuditEvents(VALID_CUSTOMER_ID, { region: "fra" });
    expect(result.nextCursor).toBeNull();
    expect(result.rows).toHaveLength(1);
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
