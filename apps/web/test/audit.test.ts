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
    getDb: (_region: "eu" | "us") => handle.db,
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
    await getAuditEvent("eu", VALID_CUSTOMER_ID, "01ARZ3NDEKTSV4RRFFQ69G5FCC");
    await getRelatedEvents("eu", VALID_CUSTOMER_ID, "q-123");
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

  it("buckets a column-masking rejection as DENIED, not FAILED", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    const sel = lastSelect(handle.queries);
    // The covert-channel gate emits a FAILED event with
    // error_class='column_masking' — a deliberate policy refusal, so it must
    // aggregate into has_masking_block and classify as DENIED (matching the
    // MCP response's policy_rule:"column_masking"), NOT the generic FAILED.
    expect(sel.sql).toContain(
      "BOOL_OR(event_type = 'FAILED' AND payload ->> 'error_class' = 'column_masking') AS has_masking_block",
    );
    expect(sel.sql).toContain("WHEN has_masking_block THEN 'DENIED'");
    // The masking-block branch must precede the generic has_failed branch,
    // or a masking rejection would fall through to FAILED.
    expect(sel.sql.indexOf("WHEN has_masking_block THEN 'DENIED'")).toBeLessThan(
      sel.sql.indexOf("WHEN has_failed THEN 'FAILED'"),
    );
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

  it("admits cloud-emitted POLICY_CHANGED / TENANT_SCOPE_CHANGED in the policy_events CTE", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    const sel = lastSelect(handle.queries);
    // Both new event_types must ride in policy_events alongside
    // POLICY_RELOADED — otherwise the actor-stamped row from
    // setTableAccess / setTenantScope is invisible in /audit and the
    // audit log can't answer "who changed it?".
    expect(sel.sql).toContain("'POLICY_CHANGED'");
    expect(sel.sql).toContain("'TENANT_SCOPE_CHANGED'");
  });

  it("admits cloud-emitted GUARDRAILS_CHANGED in the policy_events CTE", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    const sel = lastSelect(handle.queries);
    // Without this, the actor-stamped row from setGuardrails is invisible
    // in /audit — "who turned the destructive-statement net off?" would
    // have no answer.
    expect(sel.sql).toContain("'GUARDRAILS_CHANGED'");
  });

  it("admits credential events (TOKEN_CREATED / TOKEN_REVOKED) and classifies them by type", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    const sel = lastSelect(handle.queries);
    // Token mint/revoke are written to audit_events_index but were invisible
    // in /audit before this — they must ride in the event CTE so the audit
    // log can answer "who minted/killed a credential?".
    expect(sel.sql).toContain("'TOKEN_CREATED'");
    expect(sel.sql).toContain("'TOKEN_REVOKED'");
    // Classified per-type, not collapsed into POLICY_RELOAD.
    expect(sel.sql).toContain("WHEN 'TOKEN_CREATED' THEN 'TOKEN_CREATED'");
    expect(sel.sql).toContain("WHEN 'TOKEN_REVOKED' THEN 'TOKEN_REVOKED'");
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

  it("applies database filter when present (the per-DB project child)", async () => {
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

describe("countByStatus", () => {
  it("counts credential + config events per type so the chips show real totals", async () => {
    handle.setNextResult([]);
    const { countByStatus } = await import("../src/lib/audit.ts");
    await countByStatus(VALID_CUSTOMER_ID, "eu");
    const sel = lastSelect(handle.queries);
    // The event branch GROUP BYs a CASE so POLICY_RELOAD / TOKEN_CREATED /
    // TOKEN_REVOKED each get their own count, not one lumped total.
    expect(sel.sql).toContain("'TOKEN_CREATED'");
    expect(sel.sql).toContain("'TOKEN_REVOKED'");
    expect(sel.sql.toLowerCase()).toContain("group by 1");
  });

  it("counts GUARDRAILS_CHANGED rows (they ride the POLICY_RELOAD chip bucket)", async () => {
    handle.setNextResult([]);
    const { countByStatus } = await import("../src/lib/audit.ts");
    await countByStatus(VALID_CUSTOMER_ID, "eu");
    // Must be admitted by the event branch's IN list or the POLICY_RELOAD
    // chip undercounts vs. the list rows the same filter shows.
    expect(lastSelect(handle.queries).sql).toContain("'GUARDRAILS_CHANGED'");
  });

  it("scopes both branches to a project when projectId is passed", async () => {
    handle.setNextResult([]);
    const { countByStatus } = await import("../src/lib/audit.ts");
    await countByStatus(
      VALID_CUSTOMER_ID,
      "eu",
      undefined,
      undefined,
      undefined,
      "01HXCONN0000000000000000AA",
    );
    const sel = lastSelect(handle.queries);
    // Both the query agg and the event count must carry the clause so the
    // chip badges + "of N" total match a project-filtered table.
    const occurrences = (sel.sql.match(/project_id =/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(sel.params).toContain("01HXCONN0000000000000000AA");
  });

  it("adds NO project_id clause when projectId is omitted", async () => {
    handle.setNextResult([]);
    const { countByStatus } = await import("../src/lib/audit.ts");
    await countByStatus(VALID_CUSTOMER_ID, "eu");
    expect(lastSelect(handle.queries).sql).not.toContain("project_id =");
  });

  it("returns a zeroed record with every status key present", async () => {
    handle.setNextResult([]);
    const { countByStatus } = await import("../src/lib/audit.ts");
    const result = await countByStatus(VALID_CUSTOMER_ID, "eu");
    expect(result).toEqual({
      ALLOWED: 0,
      DENIED: 0,
      FAILED: 0,
      STUCK: 0,
      PENDING: 0,
      POLICY_RELOAD: 0,
      TOKEN_CREATED: 0,
      TOKEN_REVOKED: 0,
    });
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

describe("audit retention clamp", () => {
  // Matches both the raw-SQL form (`ts >= $n::timestamptz`) and the Drizzle
  // builder form (`"audit_events_index"."ts" >= $n`).
  const TS_LOWER_BOUND = /ts"?\s*>=/i;

  it("listAuditQueries adds a ts lower bound when retentionDays is set", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu", retentionDays: 7 });
    expect(lastSelect(handle.queries).sql).toMatch(TS_LOWER_BOUND);
  });

  it("listAuditQueries adds NO ts lower bound when retentionDays is omitted", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    // Only `last_ts < stuckCutoff` (a `<`, not `>=`) should be present.
    expect(lastSelect(handle.queries).sql).not.toMatch(TS_LOWER_BOUND);
  });

  it("countByStatus clamps both the query agg and the policy count", async () => {
    handle.setNextResult([]);
    const { countByStatus } = await import("../src/lib/audit.ts");
    await countByStatus(VALID_CUSTOMER_ID, "eu", undefined, 30);
    expect(lastSelect(handle.queries).sql).toMatch(TS_LOWER_BOUND);
  });

  it("getAuditEvent clamps the single-row deep-link read", async () => {
    handle.setNextResult([]);
    const { getAuditEvent } = await import("../src/lib/audit.ts");
    await getAuditEvent("eu", VALID_CUSTOMER_ID, "01ARZ3NDEKTSV4RRFFQ69G5FCC", 7);
    expect(lastSelect(handle.queries).sql).toMatch(TS_LOWER_BOUND);
  });

  it("getAuditEvent does NOT clamp when retentionDays is omitted", async () => {
    handle.setNextResult([]);
    const { getAuditEvent } = await import("../src/lib/audit.ts");
    await getAuditEvent("eu", VALID_CUSTOMER_ID, "01ARZ3NDEKTSV4RRFFQ69G5FCC");
    expect(lastSelect(handle.queries).sql).not.toMatch(TS_LOWER_BOUND);
  });

  it("listTenantIds and listDatabases clamp the chip lists", async () => {
    const { listTenantIds, listDatabases } = await import("../src/lib/audit.ts");
    handle.setNextResult([]);
    await listTenantIds(VALID_CUSTOMER_ID, "eu", 7);
    expect(lastSelect(handle.queries).sql).toMatch(TS_LOWER_BOUND);
    handle.setNextResult([]);
    await listDatabases(VALID_CUSTOMER_ID, "eu", 7);
    expect(lastSelect(handle.queries).sql).toMatch(TS_LOWER_BOUND);
  });
});

describe("audit time window", () => {
  it("parseAuditWindow coerces unknown values to 24h", async () => {
    const { parseAuditWindow } = await import("../src/lib/audit.ts");
    expect(parseAuditWindow("7d")).toBe("7d");
    expect(parseAuditWindow("30d")).toBe("30d");
    expect(parseAuditWindow("90d")).toBe("90d");
    expect(parseAuditWindow(undefined)).toBe("24h");
    expect(parseAuditWindow("bogus")).toBe("24h");
  });

  it("resolveAuditWindow leaves 24h alone and clamps long windows to retention", async () => {
    const { resolveAuditWindow } = await import("../src/lib/audit.ts");
    expect(resolveAuditWindow("24h", 7)).toEqual({
      key: "24h",
      hours: 24,
      bucket: "hour",
      bucketCount: 24,
    });
    // 30d on a 7d plan → capped to 168h, daily buckets shrink to 7.
    expect(resolveAuditWindow("30d", 7)).toEqual({
      key: "30d",
      hours: 168,
      bucket: "day",
      bucketCount: 7,
    });
    // 7d on a 30d plan → unclamped.
    expect(resolveAuditWindow("7d", 30)).toEqual({
      key: "7d",
      hours: 168,
      bucket: "day",
      bucketCount: 7,
    });
  });

  it("resolveAuditWindow lets Team reach 90d and clamps it for lower tiers", async () => {
    const { resolveAuditWindow } = await import("../src/lib/audit.ts");
    // Team (90d retention) → the full 90 daily bars, unclamped. This is the
    // whole point of the window: days 31-90 are now reachable, not capped at 30.
    expect(resolveAuditWindow("90d", 90)).toEqual({
      key: "90d",
      hours: 24 * 90,
      bucket: "day",
      bucketCount: 90,
    });
    // Pro (30d) picking 90d → clamped to 30 daily bars.
    expect(resolveAuditWindow("90d", 30)).toEqual({
      key: "90d",
      hours: 24 * 30,
      bucket: "day",
      bucketCount: 30,
    });
    // Free (7d) picking 90d → clamped to 7 daily bars.
    expect(resolveAuditWindow("90d", 7)).toEqual({
      key: "90d",
      hours: 24 * 7,
      bucket: "day",
      bucketCount: 7,
    });
  });

  it("listAuditQueries adds a ts lower bound when windowSince is set (no retention)", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      windowSince: new Date("2026-04-29T00:00:00Z"),
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toMatch(/ts"?\s*>=/i);
    expect(sel.params).toContain("2026-04-29T00:00:00.000Z");
  });

  it("auditWindowSince aligns to the bucket boundary (the chart's first bucket start)", async () => {
    const { auditWindowSince, resolveAuditWindow } = await import(
      "../src/lib/audit.ts"
    );
    const now = new Date("2026-04-30T12:34:56Z");
    // 7d → daily buckets aligned to midnight UTC, 6 days back.
    expect(
      auditWindowSince(resolveAuditWindow("7d", 30), now).toISOString(),
    ).toBe("2026-04-24T00:00:00.000Z");
    // 24h → hourly buckets aligned to the top of the hour, 23h back.
    expect(
      auditWindowSince(resolveAuditWindow("24h", 30), now).toISOString(),
    ).toBe("2026-04-29T13:00:00.000Z");
  });

  it("chart and table share the windowSince lower bound (no first-day drift)", async () => {
    // The fix for the sparkline-omits-part-of-the-window bug: the chart must
    // filter from the SAME instant the table does. Pass an explicit
    // windowSince and assert the chart query binds it AND renders its first
    // bucket there.
    handle.setNextResult([]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    const since = new Date("2026-04-24T00:00:00Z");
    const buckets = await eventVolumeByHour(VALID_CUSTOMER_ID, "eu", {
      bucket: "day",
      bucketCount: 7,
      windowSince: since,
      now: () => new Date("2026-04-30T12:00:00Z"),
    });
    expect(lastSelect(handle.queries).params).toContain(
      "2026-04-24T00:00:00.000Z",
    );
    expect(buckets[0]!.ts.toISOString()).toBe("2026-04-24T00:00:00.000Z");
  });

  it("retention stays the floor when windowSince reaches past it", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      retentionDays: 7,
      windowSince: new Date("2020-01-01T00:00:00Z"), // well before retention
      now: () => new Date("2026-04-30T12:00:00Z"),
    });
    // Lower bound = max(retention cutoff, windowSince) = retention cutoff.
    expect(lastSelect(handle.queries).params).toContain(
      "2026-04-23T12:00:00.000Z",
    );
  });

  it("listAuditQueries filters by agent_name and mcp_token_id when set", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      agentName: "claude-code",
      tokenId: "tok_42",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toContain("agent_name =");
    expect(sel.params).toContain("claude-code");
    expect(sel.sql).toContain("mcp_token_id =");
    expect(sel.params).toContain("tok_42");
  });

  it("listAuditQueries filters by project_id in BOTH the query and config-event branches", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, {
      region: "eu",
      projectId: "01HXCONN0000000000000000AA",
    });
    const sel = lastSelect(handle.queries);
    // The clause must appear in the query agg AND the policy_events CTE so
    // a project-filtered view keeps the project's config/credential
    // events alongside its queries.
    const occurrences = (sel.sql.match(/project_id =/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(sel.params).toContain("01HXCONN0000000000000000AA");
  });

  it("listAuditQueries adds NO project_id clause when projectId is omitted", async () => {
    handle.setNextResult([]);
    const { listAuditQueries } = await import("../src/lib/audit.ts");
    await listAuditQueries(VALID_CUSTOMER_ID, { region: "eu" });
    expect(lastSelect(handle.queries).sql).not.toContain("project_id =");
  });
});

describe("listAgents", () => {
  it("selects distinct non-null agent_name under RLS bind", async () => {
    handle.setNextResult([["claude-code"], ["cursor"]]);
    const { listAgents } = await import("../src/lib/audit.ts");
    const result = await listAgents(VALID_CUSTOMER_ID, "eu");
    expect(result).toEqual(["claude-code", "cursor"]);
    const sel = lastSelect(handle.queries);
    expect(sel.sql.toLowerCase()).toContain("distinct");
    expect(sel.sql).toContain("agent_name");
    expect(sel.sql.toLowerCase()).toContain("not null");
    expect(sel.inTransaction).toBe(true);
  });
});

describe("listTokenOptions", () => {
  it("joins mcp_tokens for the label and falls back to a short id", async () => {
    handle.setNextResult([
      { id: "tok_1", name: "ci-runner", last4: "ab12" },
      { id: "tok_longidxxxxxx", name: null, last4: null },
    ]);
    const { listTokenOptions } = await import("../src/lib/audit.ts");
    const result = await listTokenOptions(VALID_CUSTOMER_ID, "eu");
    expect(result[0]).toEqual({ id: "tok_1", label: "ci-runner ·ab12" });
    expect(result[1]!.id).toBe("tok_longidxxxxxx");
    expect(result[1]!.label).toMatch(/^token …/);
    const sel = lastSelect(handle.queries);
    expect(sel.sql.toLowerCase()).toContain("left join mcp_tokens");
    expect(sel.sql).toContain("mcp_token_id IS NOT NULL");
  });
});

describe("eventVolumeByHour daily bucketing", () => {
  it("returns N day-aligned buckets and date_truncs by day", async () => {
    handle.setNextResult([]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    const now = () => new Date("2026-04-30T12:34:56Z");
    const buckets = await eventVolumeByHour(VALID_CUSTOMER_ID, "eu", {
      bucket: "day",
      bucketCount: 7,
      now,
    });
    expect(buckets).toHaveLength(7);
    expect(buckets[6]!.ts.toISOString()).toBe("2026-04-30T00:00:00.000Z");
    expect(buckets[0]!.ts.toISOString()).toBe("2026-04-24T00:00:00.000Z");
    expect(lastSelect(handle.queries).sql).toContain("date_trunc('day', ts)");
  });

  it("threads agent / token filters into the chart query", async () => {
    handle.setNextResult([]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    await eventVolumeByHour(VALID_CUSTOMER_ID, "eu", {
      agentName: "claude-code",
      tokenId: "tok_42",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toContain("agent_name =");
    expect(sel.params).toContain("claude-code");
    expect(sel.sql).toContain("mcp_token_id =");
    expect(sel.params).toContain("tok_42");
  });

  it("threads projectId into the chart query so the sparkline matches a project-filtered table", async () => {
    handle.setNextResult([]);
    const { eventVolumeByHour } = await import("../src/lib/audit.ts");
    await eventVolumeByHour(VALID_CUSTOMER_ID, "eu", {
      projectId: "01HXCONN0000000000000000AA",
    });
    const sel = lastSelect(handle.queries);
    expect(sel.sql).toContain("project_id =");
    expect(sel.params).toContain("01HXCONN0000000000000000AA");
  });
});

function lastSelect(queries: RecordedQuery[]): RecordedQuery {
  // Skip the SET LOCAL bind; return the actual data query.
  const data = queries.filter((q) => !q.sql.includes("SET LOCAL"));
  const last = data[data.length - 1];
  if (!last) throw new Error("no data query was recorded");
  return last;
}
