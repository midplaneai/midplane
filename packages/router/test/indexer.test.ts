// Indexer unit tests.
//
// We hand-roll a tiny fake Db that mimics enough of Drizzle's chain shape
// to exercise the cursor + batch-insert + retention-sweep paths. A real
// pglite or sqlite would let us run actual SQL, but the indexer's logic
// is mostly fetch + cursor advance — the SQL surface is small and the
// fake keeps tests fast.

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

interface FakeDbState {
  customerByToken: Map<string, { customerId: string; region: "fra" | "iad" }>;
  cursorByToken: Map<
    string,
    { lastId: string; region: "fra" | "iad"; lastIndexedAt?: Date }
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
}

function makeFakeDb(): { db: Db; state: FakeDbState } {
  const state: FakeDbState = {
    customerByToken: new Map(),
    cursorByToken: new Map(),
    auditRows: [],
    inserts: [],
    failNextTxn: false,
    retentionMaxId: null,
  };

  const select = (
    _fields:
      | undefined
      | Record<string, unknown>,
  ) => {
    let table: unknown = null;
    let whereCond: { token?: string; customerId?: string } = {};

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
        const meta = whereCond.token
          ? state.customerByToken.get(whereCond.token)
          : undefined;
        return meta ? [meta] : [];
      }
      if (table === indexerCursors) {
        const row = whereCond.token
          ? state.cursorByToken.get(whereCond.token)
          : undefined;
        return row ? [{ lastId: row.lastId }] : [];
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
          mcpToken: string;
          region: "fra" | "iad";
          lastId: string;
          lastIndexedAt?: Date;
        }>) {
          state.cursorByToken.set(r.mcpToken, {
            lastId: r.lastId,
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
 *  doesn't work) and pulls out string Param values prefixed with "tok-"
 *  or "cust-". The Indexer's where-clauses are simple enough that this
 *  one walk covers every case. */
function parseWhere(
  cond: unknown,
): { token?: string; customerId?: string } {
  const seen = new WeakSet<object>();
  const out: { token?: string; customerId?: string } = {};

  function walk(v: unknown): void {
    if (v === null || v === undefined) return;
    if (typeof v === "string") {
      if (v.startsWith("tok-") && !out.token) out.token = v;
      else if (v.startsWith("cust-") && !out.customerId) out.customerId = v;
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
  return out;
}

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
    agent_identity: null,
    ts: 1_700_000_000_000 + parseInt(id.slice(-3), 36),
    event_type: "ATTEMPTED",
    payload: { sql_fingerprint: "abc123" },
    schema_version: 1,
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
  state.customerByToken.set("tok-A", { customerId: "cust-A", region: "fra" });

  const spawner = new StubSpawner();
  const registry = new ContainerRegistry(spawner, { idleMs: 60_000 });
  await registry.acquire({ token: "tok-A", region: "fra", dsn: "postgres://x" });

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

  it("polls /audit/since with bearer and inserts batch", async () => {
    const { db, state, registry } = await buildHarness();
    const fetchFn = vi.fn(async (url: string | URL) =>
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
    expect(state.auditRows[0]!.customerId).toBe("cust-A");
    expect(state.cursorByToken.get("tok-A")?.lastId).toBe(
      "01HX0000000000000000000002",
    );
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
    expect(state.cursorByToken.get("tok-A")?.lastId).toBe(
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

    // Cursor row is seeded at lastId="" before fetch; on txn failure it
    // stays at "" — the txn never commits the advance.
    expect(state.cursorByToken.get("tok-A")?.lastId).toBe("");
    expect(state.cursorByToken.get("tok-A")?.lastIndexedAt).toBeUndefined();
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
    expect(state.cursorByToken.get("tok-A")?.lastId).toBe(""); // seeded but never advanced
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
    expect(state.cursorByToken.get("tok-A")?.lastId).toBe(
      "01HX0000000000000000000003",
    );
    expect(errors).toHaveLength(1);
  });

  it("triggers retention DELETE only after grace window elapses", async () => {
    const { db, state, registry } = await buildHarness();
    let now = 1_800_000_000_000;
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

  it("ignores tokens that have no connections row", async () => {
    const { db, state, registry } = await buildHarness();
    state.customerByToken.clear(); // tok-A is now orphaned
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const ix = new Indexer({ db, registry, indexerToken: "t", fetch: fetchFn });
    await ix.tick();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
