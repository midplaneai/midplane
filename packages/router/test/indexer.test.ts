// Indexer unit tests.
//
// We hand-roll a tiny fake Db that mimics enough of Drizzle's chain shape
// to exercise the cursor + batch-insert + retention-sweep paths. A real
// pglite or sqlite would let us run actual SQL, but the indexer's logic
// is mostly fetch + cursor advance — the SQL surface is small and the
// fake keeps tests fast.
//
// PR2 of mcp_url_auth_security: the indexer keys on connection_id (the
// parent ULID), not the plaintext token. Audit rows propagate the OSS
// engine's `mcp_token_id` field (lockstep OSS 0.6.0) into the cloud's
// audit_events_index.mcp_token_id column.

import { describe, expect, it, vi } from "vitest";

import {
  auditEventsIndex,
  connections,
  indexerCursors,
} from "@midplane-cloud/db";

import { ContainerRegistry, type Spawner } from "../src/spawner.ts";
import { Indexer, type ContainerAuditRow } from "../src/indexer.ts";
import type { Db } from "../src/resolve.ts";

// ---------------------------------------------------------------------------
// Fake Drizzle Db
// ---------------------------------------------------------------------------

// Crockford-base32 ULID — alphabet excludes I, L, O, U. Avoid those
// characters in the literal so the parseWhere regex below matches.
const TEST_CONN_A = "01HXYZCNN000000000000000AA";

interface FakeDbState {
  customerByConnectionId: Map<
    string,
    { customerId: string; region: "eu" | "us" }
  >;
  cursorByConnectionId: Map<
    string,
    {
      lastId: string;
      customerId: string;
      region: "eu" | "us";
      lastIndexedAt?: Date;
    }
  >;
  auditRows: Array<{
    id: string;
    customerId: string;
    ts: Date;
    [k: string]: unknown;
  }>;
  /** Inserts captured for assertion. */
  inserts: Array<{
    table: "audit" | "cursor";
    rows: unknown[];
    mode: "nothing" | "update" | "none";
  }>;
  /** Forces transaction() to throw (simulates Postgres outage). */
  failNextTxn: boolean;
  /** Override for retention max-id query. */
  retentionMaxId: string | null;
  /** Captures every SET LOCAL app.customer_id = '...' bind issued
   *  inside indexer transactions. */
  boundCustomerIds: string[];
}

function makeFakeDb(): { db: Db; state: FakeDbState } {
  const state: FakeDbState = {
    customerByConnectionId: new Map(),
    cursorByConnectionId: new Map(),
    auditRows: [],
    inserts: [],
    failNextTxn: false,
    retentionMaxId: null,
    boundCustomerIds: [],
  };

  const select = (
    _fields:
      | undefined
      | Record<string, unknown>,
  ) => {
    let table: unknown = null;
    let whereCond: { connectionId?: string; customerId?: string } = {};

    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      where(c: unknown) {
        whereCond = parseWhere(c);
        return chain;
      },
      limit(_n: number) {
        return resolveSelect();
      },
      then(onFulfilled: (rows: unknown[]) => unknown) {
        return Promise.resolve(resolveSelect()).then(onFulfilled);
      },
    };

    function resolveSelect(): unknown[] {
      if (table === connections) {
        const meta = whereCond.connectionId
          ? state.customerByConnectionId.get(whereCond.connectionId)
          : undefined;
        return meta ? [meta] : [];
      }
      if (table === indexerCursors) {
        const row = whereCond.connectionId
          ? state.cursorByConnectionId.get(whereCond.connectionId)
          : undefined;
        return row
          ? [{ lastId: row.lastId, customerId: row.customerId }]
          : [];
      }
      if (table === auditEventsIndex) {
        // Retention max-id query.
        return [{ maxId: state.retentionMaxId }];
      }
      return [];
    }

    return chain;
  };

  const insert = (table: unknown) => {
    let stagedRows: unknown[] = [];
    let mode: "nothing" | "update" | "none" = "none";

    const chain = {
      values(rows: unknown[] | unknown) {
        stagedRows = Array.isArray(rows) ? rows : [rows];
        return chain;
      },
      onConflictDoNothing(_opts?: unknown) {
        mode = "nothing";
        return chain;
      },
      onConflictDoUpdate(_opts: { set: Record<string, unknown> }) {
        mode = "update";
        return chain;
      },
      then(onFulfilled: () => unknown) {
        commit();
        return Promise.resolve().then(onFulfilled);
      },
    };

    function commit(): void {
      if (table === auditEventsIndex) {
        state.inserts.push({ table: "audit", rows: stagedRows, mode });
        for (const r of stagedRows as Array<{
          id: string;
          customerId: string;
          ts: Date;
        }>) {
          if (state.auditRows.find((x) => x.id === r.id)) continue;
          state.auditRows.push(r);
        }
      } else if (table === indexerCursors) {
        state.inserts.push({ table: "cursor", rows: stagedRows, mode });
        for (const r of stagedRows as Array<{
          id: string;
          connectionId: string;
          customerId: string;
          region: "eu" | "us";
          lastId: string;
          lastIndexedAt?: Date;
        }>) {
          // onConflictDoUpdate semantics: customerId is immutable, so an
          // existing row's customerId stays — only lastId/lastIndexedAt
          // get bumped.
          const existing = state.cursorByConnectionId.get(r.connectionId);
          state.cursorByConnectionId.set(r.connectionId, {
            lastId: r.lastId,
            customerId: existing?.customerId ?? r.customerId,
            region: r.region,
            ...(r.lastIndexedAt ? { lastIndexedAt: r.lastIndexedAt } : {}),
          });
        }
      }
      stagedRows = [];
      mode = "none";
    }

    return chain;
  };

  const db = {
    select,
    insert,
    // The indexer issues `SET LOCAL app.customer_id = '<id>'` inside every
    // transaction post-0004_force_rls so the RLS policy on
    // audit_events_index doesn't block its own writes. The fake just
    // records that the bind happened with a customer_id string.
    async execute(q: unknown): Promise<unknown> {
      const text = (() => {
        if (q && typeof q === "object") {
          const r = q as {
            queryChunks?: unknown[];
            sql?: string;
            getSQL?: () => unknown;
          };
          if (typeof r.sql === "string") return r.sql;
          if (Array.isArray(r.queryChunks)) {
            return r.queryChunks
              .map((c) =>
                typeof c === "string" ? c : (c as { value?: string }).value ?? "",
              )
              .join("");
          }
        }
        return "";
      })();
      const m = /SET LOCAL app\.customer_id = '([^']+)'/.exec(text);
      if (m?.[1]) state.boundCustomerIds.push(m[1]);
      return [];
    },
    async transaction<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
      if (state.failNextTxn) {
        state.failNextTxn = false;
        throw new Error("simulated postgres outage");
      }
      return fn(db);
    },
  } as unknown as Db;

  return { db, state };
}

/** Walks a drizzle-orm SQL tree (which has cycles, so JSON.stringify
 *  doesn't work) and pulls out string Param values matching the ULID
 *  alphabet. The Indexer's where-clauses are simple enough that this
 *  one walk covers every case: the connection_id ULIDs identify
 *  connections-table and indexer_cursors-table reads alike, and the
 *  customer_id ULID is used in retention reads. We disambiguate
 *  connection vs customer by which value appears first in walk
 *  order — connection_id is always the first parameter of the
 *  where-clause in the indexer's reads. */
function parseWhere(
  cond: unknown,
): { connectionId?: string; customerId?: string } {
  const seen = new WeakSet<object>();
  const out: { connectionId?: string; customerId?: string } = {};
  const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/;
  const order: string[] = [];

  function walk(v: unknown): void {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      if (ulid.test(v) && !order.includes(v)) order.push(v);
      return;
    }
    if (typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  }
  walk(cond);
  if (order.length >= 1) out.connectionId = order[0];
  // retention queries reference customer_id; the test harness only
  // exercises one ULID per where-clause, so the first ULID is also the
  // customer_id in those paths. The harness disambiguates by which
  // table the select targets, not by walk order.
  if (order.length >= 1) out.customerId = order[0];
  return out;
}

const TEST_CUST_A = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class StubSpawner implements Spawner {
  calls = 0;
  async spawn() {
    this.calls += 1;
    return {
      host: "127.0.0.1",
      port: 30000 + this.calls,
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }
}

function row(
  id: string,
  overrides: Partial<ContainerAuditRow> = {},
): ContainerAuditRow {
  return {
    id,
    query_id: "q-1",
    tenant_id: "__self_host__",
    ts: 1_700_000_000_000 + parseInt(id.slice(-3), 36),
    event_type: "ATTEMPTED",
    payload: { sql_fingerprint: "abc123" },
    schema_version: 2,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function buildHarness(
  opts: { failNextTxn?: boolean } = {},
): Promise<{
  db: Db;
  state: FakeDbState;
  registry: ContainerRegistry;
  spawner: StubSpawner;
}> {
  const { db, state } = makeFakeDb();
  if (opts.failNextTxn) state.failNextTxn = true;
  state.customerByConnectionId.set(TEST_CONN_A, {
    customerId: TEST_CUST_A,
    region: "eu",
  });

  const spawner = new StubSpawner();
  const registry = new ContainerRegistry(spawner, { idleMs: 60_000 });
  await registry.acquire({
    connectionId: TEST_CONN_A,
    region: "eu",
    databases: [
      {
        name: "main",
        connectionDatabaseId: "01HXYZMAIN0000000000000000",
        dsn: "postgres://x",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: { column: null, overrides: {}, exempt: [] },
      },
    ],
  });

  return { db, state, registry, spawner };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Indexer", () => {
  it("requires indexerToken at construction", () => {
    const { db } = makeFakeDb();
    const reg = new ContainerRegistry(new StubSpawner());
    expect(
      () =>
        new Indexer({
          db,
          registry: reg,
          indexerToken: "",
        }),
    ).toThrow(/indexerToken is required/);
  });

  it("binds RLS via SET LOCAL app.customer_id inside the write transaction", async () => {
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [row("01HX0000000000000000000001")],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
    });
    await ix.tick();
    expect(state.boundCustomerIds).toContain(TEST_CUST_A);
  });

  it("polls /audit/since with bearer and inserts batch", async () => {
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async (_url: string | URL) =>
      jsonResponse({
        rows: [row("01HX0000000000000000000001"), row("01HX0000000000000000000002")],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;

    const ix = new Indexer({
      db,
      registry,
      indexerToken: "secret-token",
      fetch: fetchFn,
    });
    await ix.tick();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toMatch(
      /http:\/\/127\.0\.0\.1:30001\/audit\/since\/0\?limit=500$/,
    );
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret-token",
    );

    expect(state.auditRows).toHaveLength(2);
    expect(state.auditRows[0]!.customerId).toBe(TEST_CUST_A);
    expect(state.cursorByConnectionId.get(TEST_CONN_A)?.lastId).toBe(
      "01HX0000000000000000000002",
    );
  });

  it("threads mcp_token_id from OSS pull JSON into audit_events_index", async () => {
    // OSS 0.6.0 lockstep (PR2 of mcp_url_auth_security): every audit
    // row from a session carries the X-Midplane-Token-Id the cloud
    // injected at MCP initialize. The indexer copies it straight onto
    // the cloud row so dashboards can attribute by token.
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          row("01HX0000000000000000000001", {
            mcp_token_id: "01HXTOKABCDEFGHIJKLMNPQRST",
          }),
          row("01HX0000000000000000000002", {
            mcp_token_id: null,
          }),
        ],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const ix = new Indexer({ db, registry, indexerToken: "t", fetch: fetchFn });
    await ix.tick();

    expect(state.auditRows).toHaveLength(2);
    expect(
      (state.auditRows[0] as unknown as { mcpTokenId: string | null })
        .mcpTokenId,
    ).toBe("01HXTOKABCDEFGHIJKLMNPQRST");
    expect(
      (state.auditRows[1] as unknown as { mcpTokenId: string | null })
        .mcpTokenId,
    ).toBeNull();
  });

  it("drains multi-page within a single tick", async () => {
    const { db, registry, state } = await buildHarness();
    const responses = [
      jsonResponse({
        rows: [row("01HX0000000000000000000001"), row("01HX0000000000000000000002")],
        next_cursor: "01HX0000000000000000000002",
      }),
      jsonResponse({
        rows: [row("01HX0000000000000000000003")],
        next_cursor: null,
      }),
    ];
    const fetchFn = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const ix = new Indexer({ db, registry, indexerToken: "t", fetch: fetchFn });
    await ix.tick();

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const secondCall = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1] as [string, RequestInit];
    expect(secondCall[0]).toMatch(/since\/01HX0000000000000000000002\?/);
    expect(state.auditRows).toHaveLength(3);
    expect(state.cursorByConnectionId.get(TEST_CONN_A)?.lastId).toBe(
      "01HX0000000000000000000003",
    );
  });

  it("does not advance cursor when Postgres write fails", async () => {
    const { db, state, registry } = await buildHarness({ failNextTxn: true });
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [row("01HX0000000000000000000001")],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      onError: (err) => errors.push(err),
    });
    await ix.tick();

    // No cursor row exists — on txn failure the upsert never happens,
    // and the indexer no longer pre-seeds an empty cursor (that was
    // dropped along with the loadCursor() seed path; see Indexer.indexOne
    // and writeBatch).
    expect(state.cursorByConnectionId.get(TEST_CONN_A)).toBeUndefined();
    expect(state.auditRows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("does not advance cursor on container 5xx", async () => {
    const { db, registry, state } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      new Response("boom", { status: 503 }),
    ) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      onError: (err) => errors.push(err),
    });
    await ix.tick();
    expect(state.auditRows).toHaveLength(0);
    expect(state.cursorByConnectionId.get(TEST_CONN_A)).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("treats 401 from container as a fetch error (not silent)", async () => {
    const { db, registry } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "wrong",
      fetch: fetchFn,
      onError: (err) => errors.push(err),
    });
    await ix.tick();
    expect(errors).toHaveLength(1);
  });

  it("preserves unknown schema_versions (forward-compat passthrough)", async () => {
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          row("01HX0000000000000000000001", {
            schema_version: 99,
            payload: { future_field: "yes" },
          }),
        ],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const ix = new Indexer({ db, registry, indexerToken: "t", fetch: fetchFn });
    await ix.tick();

    expect(state.auditRows).toHaveLength(1);
    const inserted = state.inserts.find((i) => i.table === "audit")?.rows[0];
    expect((inserted as { schemaVersion: number }).schemaVersion).toBe(99);
  });

  it("accepts POLICY_RELOADED rows (cloud-driven hot reload event)", async () => {
    // Engine emits POLICY_RELOADED on a successful POST /admin/policy
    // hot-swap. Cloud must index it like any other audit event so
    // operators see the change in the connection-detail audit log.
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          {
            ...row("01HX0000000000000000000001"),
            event_type: "POLICY_RELOADED",
            payload: { reason: "cloud admin POST" },
          },
        ],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      onError: (err) => errors.push(err),
    });
    await ix.tick();

    expect(state.auditRows).toHaveLength(1);
    expect(
      (state.auditRows[0] as unknown as { eventType: string }).eventType,
    ).toBe("POLICY_RELOADED");
    expect(errors).toHaveLength(0);
  });

  it("drops schema-invalid rows but advances cursor past them", async () => {
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          row("01HX0000000000000000000001"),
          // bad event_type
          { ...row("01HX0000000000000000000002"), event_type: "BANANA" },
          row("01HX0000000000000000000003"),
        ],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      onError: (err) => errors.push(err),
    });
    await ix.tick();

    expect(state.auditRows.map((r) => r.id)).toEqual([
      "01HX0000000000000000000001",
      "01HX0000000000000000000003",
    ]);
    expect(state.cursorByConnectionId.get(TEST_CONN_A)?.lastId).toBe(
      "01HX0000000000000000000003",
    );
    expect(errors).toHaveLength(1);
  });

  it("persists agent_name/version/intent/intent_source from new-shape rows", async () => {
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          {
            ...row("01HX0000000000000000000001"),
            agent_name: "claude-code",
            agent_version: "0.42.1",
            agent_intent: "count active connections",
            intent_source: "mcp_meta",
          },
        ],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const ix = new Indexer({ db, registry, indexerToken: "t", fetch: fetchFn });
    await ix.tick();

    const persisted = state.auditRows[0]!;
    expect(persisted.agentName).toBe("claude-code");
    expect(persisted.agentVersion).toBe("0.42.1");
    expect(persisted.agentIntent).toBe("count active connections");
    expect(persisted.intentSource).toBe("mcp_meta");
  });

  it("rejects rows with invalid intent_source", async () => {
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          {
            ...row("01HX0000000000000000000001"),
            intent_source: "smuggled_channel",
          },
          row("01HX0000000000000000000002"),
        ],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      onError: (err) => errors.push(err),
    });
    await ix.tick();

    expect(state.auditRows.map((r) => r.id)).toEqual([
      "01HX0000000000000000000002",
    ]);
    expect(errors).toHaveLength(1);
  });

  it("rejects rows with agent_intent over the 500-char cap", async () => {
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          {
            ...row("01HX0000000000000000000001"),
            agent_intent: "a".repeat(501),
          },
        ],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const errors: unknown[] = [];
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      onError: (err) => errors.push(err),
    });
    await ix.tick();

    expect(state.auditRows).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it("triggers retention DELETE only after grace window elapses", async () => {
    const { db, state, registry } = await buildHarness();
    const now = 1_800_000_000_000;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("/audit/before/")) return jsonResponse({ deleted: 5 });
      return jsonResponse({
        rows: [row("01HX0000000000000000000001")],
        next_cursor: null,
      });
    }) as unknown as typeof fetch;
    state.retentionMaxId = "01HX0000000000000000000001";
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      now: () => now,
      retentionSweepMs: 0, // run sweep every tick
    });

    await ix.tick();
    // First tick: insert + sweep. retentionMaxId set above, so DELETE
    // does fire.
    const deleteCalls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
      .calls.filter((c) => String(c[0]).includes("/audit/before/"));
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0]?.[1] as RequestInit).method).toBe("DELETE");
  });

  it("skips retention when no rows are old enough", async () => {
    const { db, registry, state } = await buildHarness();
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [row("01HX0000000000000000000001")],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    state.retentionMaxId = null; // nothing past the grace window
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      retentionSweepMs: 0,
    });
    await ix.tick();
    const deleteCalls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
      .calls.filter((c) => String(c[0]).includes("/audit/before/"));
    expect(deleteCalls).toHaveLength(0);
  });

  it("ignores connections that have no connections row AND no cursor row", async () => {
    const { db, state, registry } = await buildHarness();
    state.customerByConnectionId.clear(); // TEST_CONN_A is now orphaned
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const ix = new Indexer({ db, registry, indexerToken: "t", fetch: fetchFn });
    await ix.tick();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("keeps draining after the connection row is deleted (cursor-stamped customer_id survives)", async () => {
    const { db, state, registry } = await buildHarness();

    // Tick 1: first index stamps customer_id on the cursor row.
    const responses = [
      jsonResponse({
        rows: [row("01HX0000000000000000000001")],
        next_cursor: null,
      }),
      jsonResponse({
        rows: [row("01HX0000000000000000000002")],
        next_cursor: null,
      }),
    ];
    const fetchFn = vi.fn(async () => responses.shift()!) as unknown as typeof fetch;
    const ix = new Indexer({ db, registry, indexerToken: "t", fetch: fetchFn });
    await ix.tick();
    expect(state.cursorByConnectionId.get(TEST_CONN_A)?.customerId).toBe(
      TEST_CUST_A,
    );
    expect(state.auditRows).toHaveLength(1);

    // Now the user deletes the connection — connections row gone.
    // (The cursor row's connection_id flips to NULL via FK ON DELETE SET
    // NULL in production; the test harness simulates the racing case
    // where the connection is gone but the cursor row hasn't been swept
    // yet, because the container has un-drained rows.)
    state.customerByConnectionId.clear();

    // Tick 2: indexer reads customer_id from the cursor row, drains the
    // remaining backlog, and the high-severity data-loss bug is gone.
    await ix.tick();
    expect(state.auditRows.map((r) => r.id)).toEqual([
      "01HX0000000000000000000001",
      "01HX0000000000000000000002",
    ]);
    expect(state.cursorByConnectionId.get(TEST_CONN_A)?.lastId).toBe(
      "01HX0000000000000000000002",
    );
  });
});
