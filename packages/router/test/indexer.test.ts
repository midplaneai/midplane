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
// audit_events_index.mcp_token_id column. The fake tracks:
//   - cursors by both synthetic id AND connection_id, so the
//     drain-after-delete path (FK ON DELETE SET NULL flips connection_id
//     to NULL, but the cursorId stays stable) can be exercised.
//   - mcpTokens existence, so the audit-insert FK guard can be probed
//     (CASCADE-deleted token rows should make INSERTs NULL out the
//     mcp_token_id instead of tripping the FK).

import { describe, expect, it, vi } from "vitest";

import {
  auditEventsIndex,
  connections,
  indexerCursors,
  mcpTokens,
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

interface CursorRow {
  id: string;
  connectionId: string | null;
  lastId: string;
  customerId: string;
  region: "eu" | "us";
  lastIndexedAt?: Date;
  /** Error stamps for the freshness dot — written by recordError on a
   *  failed drain, cleared back to null by the next successful drain. */
  lastError?: string | null;
  lastErrorAt?: Date | null;
}

interface FakeDbState {
  customerByConnectionId: Map<
    string,
    { customerId: string; region: "eu" | "us" }
  >;
  /** Cursor rows indexed by their synthetic id PK. Lookups happen by id
   *  (cache hit path), by connection_id (cache miss / first sighting),
   *  and updates can target either depending on the indexer's state. */
  cursorsById: Map<string, CursorRow>;
  auditRows: Array<{
    id: string;
    customerId: string;
    ts: Date;
    [k: string]: unknown;
  }>;
  /** mcp_tokens table for the FK guard test. Only ids stored — the
   *  indexer's pre-check just verifies existence. */
  extantTokenIds: Set<string>;
  /** Inserts captured for assertion. */
  inserts: Array<{
    table: "audit" | "cursor";
    rows: unknown[];
    mode: "nothing" | "update" | "none";
  }>;
  /** UPDATEs captured for assertion (e.g., the cursor cache-hit path). */
  updates: Array<{ table: unknown; set: unknown; where: unknown }>;
  /** Forces transaction() to throw (simulates Postgres outage). */
  failNextTxn: boolean;
  /** Override for retention max-id query. */
  retentionMaxId: string | null;
  /** Captures every SET LOCAL app.customer_id = '...' bind issued
   *  inside indexer transactions. */
  boundCustomerIds: string[];
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function makeFakeDb(): { db: Db; state: FakeDbState } {
  const state: FakeDbState = {
    customerByConnectionId: new Map(),
    cursorsById: new Map(),
    auditRows: [],
    extantTokenIds: new Set(),
    inserts: [],
    updates: [],
    failNextTxn: false,
    retentionMaxId: null,
    boundCustomerIds: [],
  };

  // Find a cursor by its current connection_id (NULL is never returned —
  // the partial unique index in 0018 only covers non-null connection_id).
  function cursorByConnectionId(connectionId: string): CursorRow | undefined {
    for (const row of state.cursorsById.values()) {
      if (row.connectionId === connectionId) return row;
    }
    return undefined;
  }

  const select = (
    _fields:
      | undefined
      | Record<string, unknown>,
  ) => {
    let table: unknown = null;
    let whereCond: WhereExtract = { allUlids: [], colsSeen: new Set() };

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
        // resolveCustomer: WHERE id = $1 (connection id, single param).
        const meta = whereCond.firstUlid
          ? state.customerByConnectionId.get(whereCond.firstUlid)
          : undefined;
        return meta ? [meta] : [];
      }
      if (table === indexerCursors) {
        // Two read shapes from the indexer:
        //   loadCursorRow cache hit  → WHERE id = $1
        //   loadCursorRow cache miss → WHERE connection_id = $1
        //   writeBatch post-upsert   → WHERE connection_id = $1
        // Disambiguate by which column name appeared in the where tree.
        let row: CursorRow | undefined;
        if (whereCond.firstUlid) {
          if (whereCond.colsSeen.has("id")) {
            row = state.cursorsById.get(whereCond.firstUlid);
          } else if (whereCond.colsSeen.has("connection_id")) {
            row = cursorByConnectionId(whereCond.firstUlid);
          }
        }
        return row
          ? [
              {
                id: row.id,
                lastId: row.lastId,
                customerId: row.customerId,
              },
            ]
          : [];
      }
      if (table === mcpTokens) {
        // FK guard pre-check: SELECT id FROM mcp_tokens WHERE id IN (…).
        // inArray expands to multiple Params in the where tree; the
        // walker collects all of them into allUlids — match each
        // against the extantTokenIds set and return the survivors.
        return whereCond.allUlids
          .filter((id) => state.extantTokenIds.has(id))
          .map((id) => ({ id }));
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
          lastId?: string;
          lastIndexedAt?: Date;
          lastError?: string | null;
          lastErrorAt?: Date | null;
        }>) {
          // onConflictDoUpdate semantics: customerId is immutable, so an
          // existing row's customerId stays — only lastId/lastIndexedAt
          // (and the error stamps) get bumped. Look up the existing
          // cursor by connection_id (the partial unique index's target
          // predicate); if found, treat this as an UPDATE-in-place and
          // keep the existing id. recordError's insert carries no lastId
          // (schema default "") — don't clobber an existing one.
          const existing = cursorByConnectionId(r.connectionId);
          if (existing) {
            if (r.lastId !== undefined) existing.lastId = r.lastId;
            if (r.lastIndexedAt) existing.lastIndexedAt = r.lastIndexedAt;
            if (r.lastError !== undefined) existing.lastError = r.lastError;
            if (r.lastErrorAt !== undefined)
              existing.lastErrorAt = r.lastErrorAt;
            // Note: customerId NOT updated on conflict — immutable.
            continue;
          }
          state.cursorsById.set(r.id, {
            id: r.id,
            connectionId: r.connectionId,
            lastId: r.lastId ?? "",
            customerId: r.customerId,
            region: r.region,
            ...(r.lastIndexedAt ? { lastIndexedAt: r.lastIndexedAt } : {}),
            ...(r.lastError !== undefined ? { lastError: r.lastError } : {}),
            ...(r.lastErrorAt !== undefined
              ? { lastErrorAt: r.lastErrorAt }
              : {}),
          });
        }
      }
      stagedRows = [];
      mode = "none";
    }

    return chain;
  };

  const update = (table: unknown) => {
    let setValue: unknown;
    let whereCond: WhereExtract = { allUlids: [], colsSeen: new Set() };

    const chain = {
      set(v: unknown) {
        setValue = v;
        return chain;
      },
      where(c: unknown) {
        whereCond = parseWhere(c);
        return chain;
      },
      then(onFulfilled: () => unknown) {
        commit();
        return Promise.resolve().then(onFulfilled);
      },
    };

    function commit(): void {
      state.updates.push({ table, set: setValue, where: whereCond });
      if (table === indexerCursors) {
        // Cache-hit path: UPDATE indexer_cursors SET ... WHERE id = $1
        // (the cached cursorId). The where tree references the `id`
        // column only — no connection_id, so we route via colsSeen.
        if (
          whereCond.firstUlid &&
          whereCond.colsSeen.has("id") &&
          !whereCond.colsSeen.has("connection_id")
        ) {
          const row = state.cursorsById.get(whereCond.firstUlid);
          if (!row) return;
          const s = setValue as
            | {
                lastId?: string;
                lastIndexedAt?: Date;
                lastError?: string | null;
                lastErrorAt?: Date | null;
              }
            | undefined;
          if (s?.lastId !== undefined) row.lastId = s.lastId;
          if (s?.lastIndexedAt !== undefined)
            row.lastIndexedAt = s.lastIndexedAt;
          if (s?.lastError !== undefined) row.lastError = s.lastError;
          if (s?.lastErrorAt !== undefined) row.lastErrorAt = s.lastErrorAt;
        }
      }
      setValue = undefined;
      whereCond = { allUlids: [], colsSeen: new Set() };
    }

    return chain;
  };

  const db = {
    select,
    insert,
    update,
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

interface WhereExtract {
  /** First ULID-shaped string found in walk order. Convenience for the
   *  single-param reads (cursor + connections); resolveSelect picks
   *  between this and allUlids based on table identity. */
  firstUlid?: string;
  /** All ULID-shaped strings collected from the where tree, in walk
   *  order. The mcpTokens FK pre-check uses inArray(...) which expands
   *  to multiple Param nodes; collecting them all is more robust than
   *  trying to recognize drizzle's inArray expression shape. */
  allUlids: string[];
  /** Set of column names seen in the where tree. Used to route reads
   *  on indexer_cursors between the cache-hit path (WHERE id = $1) and
   *  the cache-miss path (WHERE connection_id = $1) — both pass the
   *  same ULID-shaped param, but reference different columns. */
  colsSeen: Set<string>;
}

/** Walks a drizzle-orm SQL tree (which has cycles, so JSON.stringify
 *  doesn't work) and pulls out (a) all ULID-shaped Param values and
 *  (b) the set of column names referenced (column objects have a
 *  `.name` property). */
function parseWhere(cond: unknown): WhereExtract {
  const seen = new WeakSet<object>();
  const out: WhereExtract = { allUlids: [], colsSeen: new Set() };

  function walk(v: unknown): void {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      if (ULID_RE.test(v) && !out.allUlids.includes(v)) out.allUlids.push(v);
      return;
    }
    if (typeof v !== "object") return;
    if (seen.has(v as object)) return;
    seen.add(v as object);
    const colName = (v as { name?: unknown }).name;
    if (typeof colName === "string") {
      // Drizzle Column objects reference their parent PgTable via
      // `.table`, which in turn exposes every sibling column on the
      // table. A naive recursion into a Column's `.table` would pull
      // every column name on indexer_cursors into colsSeen, defeating
      // the routing in resolveSelect. Record the name and STOP — we
      // don't need anything else from this subtree.
      out.colsSeen.add(colName);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  }
  walk(cond);

  if (out.allUlids.length >= 1) out.firstUlid = out.allUlids[0];
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
    const cursor = [...state.cursorsById.values()].find(
      (c) => c.connectionId === TEST_CONN_A,
    );
    expect(cursor?.lastId).toBe("01HX0000000000000000000002");
  });

  it("threads mcp_token_id from OSS pull JSON into audit_events_index (when token row exists)", async () => {
    // OSS 0.6.0 lockstep (PR2 of mcp_url_auth_security): every audit
    // row from a session carries the X-Midplane-Token-Id the cloud
    // injected at MCP initialize. The indexer copies it through after
    // confirming the mcp_tokens row still exists (FK guard for the
    // post-connection-delete CASCADE case — covered in a separate
    // test below).
    const { db, state, registry } = await buildHarness();
    state.extantTokenIds.add("01HXTKN00000000000000000AA");
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          row("01HX0000000000000000000001", {
            mcp_token_id: "01HXTKN00000000000000000AA",
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
    ).toBe("01HXTKN00000000000000000AA");
    expect(
      (state.auditRows[1] as unknown as { mcpTokenId: string | null })
        .mcpTokenId,
    ).toBeNull();
  });

  it("NULLs out mcp_token_id when the referenced token has been CASCADE-deleted (FK guard)", async () => {
    // Connection deleted → mcp_tokens row CASCADE-removed via FK ON
    // DELETE CASCADE on mcp_tokens.connection_id. The OSS container's
    // SQLite still has backlog rows referencing the (now-gone) token
    // id. Without the guard, the audit INSERT trips
    // audit_events_index_mcp_token_id_fk and rolls back the batch,
    // breaking the documented drain-after-delete path. The guard
    // probes existence pre-insert and NULLs out missing references.
    const { db, state, registry } = await buildHarness();
    // No tokens registered → all referenced ids treated as missing.
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          row("01HX0000000000000000000001", {
            mcp_token_id: "01HXTKN00000000000000000DD",
          }),
          row("01HX0000000000000000000002", {
            mcp_token_id: "01HXTKN00000000000000000DD",
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
    ).toBeNull();
    expect(
      (state.auditRows[1] as unknown as { mcpTokenId: string | null })
        .mcpTokenId,
    ).toBeNull();
  });

  it("partially NULLs mcp_token_id — kept where the token row still exists, NULL'd where it's been deleted", async () => {
    // Mixed batch: a still-live token and a CASCADE-deleted one. Only
    // the missing reference is NULL'd; the live one passes through.
    const { db, state, registry } = await buildHarness();
    state.extantTokenIds.add("01HXTKN00000000000000000BB");
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [
          row("01HX0000000000000000000001", {
            mcp_token_id: "01HXTKN00000000000000000BB",
          }),
          row("01HX0000000000000000000002", {
            mcp_token_id: "01HXTKN00000000000000000CC",
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
    ).toBe("01HXTKN00000000000000000BB");
    expect(
      (state.auditRows[1] as unknown as { mcpTokenId: string | null })
        .mcpTokenId,
    ).toBeNull();
  });

  it("survives ON DELETE SET NULL: cursor reads + writes route through cached cursor id", async () => {
    // Drain-after-delete: PR2's design promises that a cursor's
    // connection_id can flip to NULL via FK ON DELETE SET NULL while
    // the indexer keeps draining the OSS container's backlog. The
    // implementation maintains an in-memory cursorIdByConnectionId
    // cache: after the first tick stamps it, subsequent reads use
    // WHERE id = $cursorId (stable) and writes use UPDATE ... WHERE
    // id = $cursorId (no FK conflict from re-inserting the now-
    // dangling connection_id).
    const { db, state, registry } = await buildHarness();

    // Tick 1: first sighting populates the cache via the connection_id
    // read + upsert. Cursor row is created with connection_id set.
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

    const cursorBeforeDelete = [...state.cursorsById.values()].find(
      (c) => c.connectionId === TEST_CONN_A,
    );
    expect(cursorBeforeDelete, "first tick must stamp the cursor row").toBeDefined();
    expect(cursorBeforeDelete!.customerId).toBe(TEST_CUST_A);
    expect(cursorBeforeDelete!.lastId).toBe("01HX0000000000000000000001");

    // Simulate the connection delete: FK ON DELETE SET NULL flips the
    // cursor's connection_id to NULL. The customers-table is also gone
    // (the indexer's resolveCustomer fallback would now miss too).
    cursorBeforeDelete!.connectionId = null;
    state.customerByConnectionId.clear();

    // Tick 2: indexer should pull the cursor row via its cached id,
    // get customer_id from there (NOT from the connections fallback,
    // which is gone), and write the new batch via UPDATE-by-id.
    await ix.tick();

    // Audit row landed despite the connection-row being gone.
    expect(state.auditRows.map((r) => r.id)).toEqual([
      "01HX0000000000000000000001",
      "01HX0000000000000000000002",
    ]);

    // The cursor row's last_id advanced — proves UPDATE-by-id worked.
    const cursorAfter = state.cursorsById.get(cursorBeforeDelete!.id);
    expect(cursorAfter?.lastId).toBe("01HX0000000000000000000002");
    // And the row's connection_id stays NULL — we did NOT re-INSERT
    // (which would have tripped the dangling FK reference).
    expect(cursorAfter?.connectionId).toBeNull();

    // Verify the second tick's write went through update(), not
    // insert(). Pre-delete tick: one cursor insert. Post-delete tick:
    // one cursor update.
    const cursorUpdates = state.updates.filter(
      (u) => u.table === indexerCursors,
    );
    expect(cursorUpdates).toHaveLength(1);
    const updateWhere = cursorUpdates[0]!.where as WhereExtract;
    expect(updateWhere.firstUlid).toBe(cursorBeforeDelete!.id);
    expect(updateWhere.colsSeen.has("id")).toBe(true);
    expect(updateWhere.colsSeen.has("connection_id")).toBe(false);
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
    const cursor = [...state.cursorsById.values()].find(
      (c) => c.connectionId === TEST_CONN_A,
    );
    expect(cursor?.lastId).toBe("01HX0000000000000000000003");
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

    // The real invariant: the cursor does not ADVANCE on txn failure —
    // the batch upsert never happens, so lastId stays at the schema
    // default "". recordError does create a row now (error stamps only)
    // so the freshness dot can go red; that row must not carry drain
    // progress.
    expect(state.auditRows).toHaveLength(0);
    const cursor = [...state.cursorsById.values()].find(
      (c) => c.connectionId === TEST_CONN_A,
    );
    expect(cursor?.lastId ?? "").toBe("");
    expect(cursor?.lastIndexedAt).toBeUndefined();
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
    // Cursor must not ADVANCE on 5xx; the error-stamped row recordError
    // creates carries no drain progress (lastId stays "").
    const cursor = [...state.cursorsById.values()].find(
      (c) => c.connectionId === TEST_CONN_A,
    );
    expect(cursor?.lastId ?? "").toBe("");
    expect(cursor?.lastIndexedAt).toBeUndefined();
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
    const cursor = [...state.cursorsById.values()].find(
      (c) => c.connectionId === TEST_CONN_A,
    );
    expect(cursor?.lastId).toBe("01HX0000000000000000000003");
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
});

// ---------------------------------------------------------------------------
// Error recording — the freshness dot's "down" state
// ---------------------------------------------------------------------------
//
// REGRESSION GUARD: before this change the indexer only ever CLEARED
// last_error_at (to null, on successful drain) and never wrote a
// timestamp — so computeFreshness's "down" branch (apps/web/src/lib/
// freshness.ts) was unreachable and every dashboard dot stayed green no
// matter how broken an engine was. These tests pin the new behavior:
// failed drains stamp last_error / last_error_at, successful drains
// still clear them.

describe("Indexer error recording", () => {
  const CURSOR_ID = "01HXCRSR000000000000000000";

  it("stamps lastError/lastErrorAt on the existing cursor row when the drain fails", async () => {
    const { db, state, registry } = await buildHarness();
    state.cursorsById.set(CURSOR_ID, {
      id: CURSOR_ID,
      connectionId: TEST_CONN_A,
      lastId: "01HX0000000000000000000001",
      customerId: TEST_CUST_A,
      region: "eu",
      lastIndexedAt: new Date("2026-06-01T00:00:00Z"),
    });
    const onError = vi.fn();
    const fetchFn = vi.fn(
      async () => new Response("boom", { status: 500 }),
    ) as unknown as typeof fetch;
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      onError,
    });
    await ix.tick();

    const cursor = state.cursorsById.get(CURSOR_ID)!;
    expect(cursor.lastErrorAt).toBeInstanceOf(Date);
    expect(cursor.lastError).toMatch(/audit\/since 500/);
    // Error newer than the last good drain → the dot's "down" condition.
    expect(cursor.lastErrorAt!.getTime()).toBeGreaterThan(
      cursor.lastIndexedAt!.getTime(),
    );
    // Recording supplements the operator callback, never replaces it.
    expect(onError).toHaveBeenCalled();
  });

  it("creates a cursor row with lastErrorAt when the engine errors before any successful drain", async () => {
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(
      async () => new Response("boom", { status: 502 }),
    ) as unknown as typeof fetch;
    const ix = new Indexer({ db, registry, indexerToken: "t", fetch: fetchFn });
    await ix.tick();

    const cursor = [...state.cursorsById.values()].find(
      (c) => c.connectionId === TEST_CONN_A,
    );
    expect(cursor).toBeDefined();
    expect(cursor!.lastErrorAt).toBeInstanceOf(Date);
    expect(cursor!.lastError).toMatch(/audit\/since 502/);
    expect(cursor!.lastIndexedAt).toBeUndefined();
    expect(cursor!.customerId).toBe(TEST_CUST_A);
  });

  it("stamps lastErrorAt when the write phase fails (postgres outage)", async () => {
    const { db, state, registry } = await buildHarness({ failNextTxn: true });
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [row("01HX0000000000000000000001")],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const onError = vi.fn();
    const ix = new Indexer({
      db,
      registry,
      indexerToken: "t",
      fetch: fetchFn,
      onError,
    });
    await ix.tick();

    const cursor = [...state.cursorsById.values()].find(
      (c) => c.connectionId === TEST_CONN_A,
    );
    expect(cursor).toBeDefined();
    expect(cursor!.lastError).toMatch(/simulated postgres outage/);
    expect(cursor!.lastErrorAt).toBeInstanceOf(Date);
    expect(onError).toHaveBeenCalledWith(expect.anything(), {
      connectionId: TEST_CONN_A,
      phase: "write",
    });
  });

  it("clears lastError/lastErrorAt on the next successful drain", async () => {
    const { db, state, registry } = await buildHarness();
    state.cursorsById.set(CURSOR_ID, {
      id: CURSOR_ID,
      connectionId: TEST_CONN_A,
      lastId: "01HX0000000000000000000001",
      customerId: TEST_CUST_A,
      region: "eu",
      lastIndexedAt: new Date("2026-06-01T00:00:00Z"),
      lastError: "audit/since 500 from 127.0.0.1:30001",
      lastErrorAt: new Date("2026-06-02T00:00:00Z"),
    });
    const fetchFn = vi.fn(async () =>
      jsonResponse({
        rows: [row("01HX0000000000000000000002")],
        next_cursor: null,
      }),
    ) as unknown as typeof fetch;
    const ix = new Indexer({ db, registry, indexerToken: "t", fetch: fetchFn });
    await ix.tick();

    const cursor = state.cursorsById.get(CURSOR_ID)!;
    expect(cursor.lastError).toBeNull();
    expect(cursor.lastErrorAt).toBeNull();
    expect(cursor.lastId).toBe("01HX0000000000000000000002");
    expect(cursor.lastIndexedAt).toBeInstanceOf(Date);
  });
});
