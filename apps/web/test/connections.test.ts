// Unit coverage for the connections lib.
//
// deleteConnection: cleanup invariant — no orphan indexer_cursors rows.
// rotateConnection: critical path — DB write atomicity AND in-memory cache
//   invalidation must both fire on the happy path. Failure to invalidate
//   either DecryptCache or ContainerRegistry means a rotated DSN keeps
//   serving the OLD credentials until the 30-min idle timer fires (security
//   incident). The 404 path proves we don't touch caches when ownership
//   doesn't match. The failure-isolation case proves a cache layer throwing
//   doesn't strand the registry layer (the durable fact is "DSN rotated").
//
// 0008 schema split: the credential row moved to connection_databases.
// Rotation now selects the parent (for ownership + token + region) and
// updates the child (for the DSN ciphertext + rotated_at). DecryptCache
// invalidation keys per-credential — the test asserts the child's id is
// passed to cache.invalidate, not the parent id.
//
// All mocks are shape-only — no real Postgres or KMS contact, so the suite
// runs in vitest's plain node env.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface DbCall {
  op: "delete" | "update" | "select" | "insert" | "execute";
  table?: unknown;
  set?: unknown;
  where?: unknown;
  returning?: Record<string, unknown>;
}

interface FakeDbHandle {
  db: object;
  calls: DbCall[];
  /** Result of a parent-table select (rotateConnection's ownership check
   *  reads connections, returning {id, region}). PR2 of
   *  mcp_url_auth_security: parent rows no longer carry mcp_token — the
   *  agent-facing surface lives in the mcp_tokens table. */
  setParentSelectResult(
    rows: Array<{ id: string; region?: string }>,
  ): void;
  /** Result of a connection_databases UPDATE…RETURNING (rotateConnection
   *  needs the child id to feed DecryptCache.invalidate). */
  setChildUpdateResult(rows: Array<{ id: string }>): void;
  /** Result of a connections DELETE…RETURNING (deleteConnection — returns
   *  just {id} since PR2; registry keys on connection id, not token). */
  setConnectionsReturning(rows: Array<{ id: string }>): void;
  /** Push the result for the NEXT select() call. Drains in FIFO order;
   *  once empty, selects fall back to setParentSelectResult. Lets
   *  multi-select helpers (addDatabase: parent + sibling-collision;
   *  removeDatabase: parent + sibling count) stage each read
   *  independently. */
  queueSelect(rows: unknown[]): void;
  /** Result of a connection_databases DELETE…RETURNING (removeDatabase).
   *  Distinct from connections DELETE so the two helpers don't share
   *  fixture state. */
  setChildDeleteResult(rows: Array<{ id: string }>): void;
  /** Make the next insert reject with the given error. Used to simulate
   *  the race-loser path on add/rename where the FOR UPDATE lock has
   *  somehow been bypassed and the unique constraint trips. */
  failNextInsert(err: unknown): void;
  /** Make the next update reject with the given error. Same role as
   *  failNextInsert but for the rename path (UPDATE SET name=?). */
  failNextUpdate(err: unknown): void;
}

let handle: FakeDbHandle;

function makeFakeDb(): FakeDbHandle {
  let parentSelect: Array<{
    id: string;
    region?: string;
  }> = [];
  let childUpdate: Array<{ id: string }> = [];
  let childDelete: Array<{ id: string }> = [];
  let childDeleteSet = false;
  let deletedConnections: Array<{ id: string }> = [];
  const selectQueue: Array<unknown[]> = [];
  const calls: DbCall[] = [];
  const insertErrorQueue: unknown[] = [];
  const updateErrorQueue: unknown[] = [];

  const makeRoot = () => {
    const startMutation = (op: "delete" | "update", table: unknown) => {
      let setValue: unknown;
      let whereValue: unknown;
      const chain = {
        set(v: unknown) {
          setValue = v;
          return chain;
        },
        where(c: unknown) {
          whereValue = c;
          return chain;
        },
        returning(fields: Record<string, unknown>) {
          calls.push({
            op,
            table,
            set: setValue,
            where: whereValue,
            returning: fields,
          });
          if (op === "update" && updateErrorQueue.length > 0) {
            return Promise.reject(updateErrorQueue.shift());
          }
          if (op === "delete") {
            // Distinguish deletes on `connections` (deleteConnection,
            // returning {id}) from deletes on `connection_databases`
            // (removeDatabase, also returning {id}).
            // We use an explicit "did the test set childDelete?" flag
            // so an empty array is honored — necessary for the
            // "dbName not on connection" path where the delete really
            // does match 0 rows.
            if (childDeleteSet) return Promise.resolve(childDelete);
            return Promise.resolve(deletedConnections);
          }
          const set = setValue as Record<string, unknown> | undefined;
          // Child updates on connection_databases set the credential
          // columns (rotateConnection), the policy column
          // (setTableAccess), the alias column (renameDatabase via
          // {name}), or the tenant_scope config. Parent updates on
          // connections only set {name} via renameConnection — but
          // since the test never exercises that simultaneously with a
          // child rename, prefer childUpdate when populated.
          if (
            set &&
            ("encryptedDsn" in set ||
              "tableAccess" in set ||
              "tenantScope" in set)
          ) {
            return Promise.resolve(childUpdate);
          }
          if (set && "name" in set && childUpdate.length > 0) {
            // renameDatabase update: set {name}, returning {id}.
            return Promise.resolve(childUpdate);
          }
          return Promise.resolve([]);
        },
        then(onFulfilled: (rows: unknown[]) => unknown) {
          // Used by the cursor delete which doesn't call .returning().
          calls.push({ op, table, set: setValue, where: whereValue });
          return Promise.resolve([]).then(onFulfilled);
        },
      };
      return chain;
    };

    const startSelect = () => {
      let table: unknown;
      let whereValue: unknown;
      const resolveRows = () =>
        selectQueue.length > 0 ? selectQueue.shift()! : parentSelect;
      const chain = {
        from(t: unknown) {
          table = t;
          return chain;
        },
        where(c: unknown) {
          whereValue = c;
          return chain;
        },
        leftJoin() {
          return chain;
        },
        innerJoin() {
          return chain;
        },
        groupBy() {
          return chain;
        },
        for() {
          // SELECT ... FOR UPDATE — the fake doesn't model row locks,
          // but the chain method has to exist so the helpers can call
          // it. Concurrency behavior is verified at the integration
          // layer (against a real Postgres); this no-op is enough for
          // shape testing.
          return chain;
        },
        limit() {
          calls.push({ op: "select", table, where: whereValue });
          return Promise.resolve(resolveRows());
        },
        orderBy() {
          return chain;
        },
        then(onFulfilled: (rows: unknown[]) => unknown) {
          calls.push({ op: "select", table, where: whereValue });
          return Promise.resolve(resolveRows()).then(onFulfilled);
        },
      };
      return chain;
    };

    const startInsert = (table: unknown) => {
      const chain = {
        values(row: unknown) {
          calls.push({ op: "insert", table, set: row });
          if (insertErrorQueue.length > 0) {
            return Promise.reject(insertErrorQueue.shift());
          }
          // Insert is fire-and-forget (the lib generates ULIDs outside
          // the txn and doesn't .returning() — addDatabase tracks the
          // child id from outside). Resolve void to mirror Drizzle.
          return Promise.resolve();
        },
      };
      return chain;
    };

    return {
      delete(t: unknown) {
        return startMutation("delete", t);
      },
      update(t: unknown) {
        return startMutation("update", t);
      },
      select(_fields?: unknown) {
        return startSelect();
      },
      insert(t: unknown) {
        return startInsert(t);
      },
      // SET LOCAL app.customer_id (RLS bind) reaches the driver via
      // tx.execute(sql.raw(...)). The fake doesn't model RLS — we just
      // record the raw SQL text so audit-emission tests can assert the
      // bind fired. Drizzle's sql.raw stashes the string in
      // queryChunks[0].value[0]; we extract it for stable comparison.
      async execute(stmt: unknown) {
        const chunks = (stmt as { queryChunks?: Array<{ value?: unknown }> })
          ?.queryChunks;
        const raw =
          chunks && Array.isArray(chunks) && chunks.length > 0
            ? Array.isArray((chunks[0] as { value?: unknown }).value)
              ? ((chunks[0] as { value: unknown[] }).value[0] as string)
              : String((chunks[0] as { value?: unknown }).value ?? "")
            : "";
        calls.push({ op: "execute", set: raw });
        return { rows: [] };
      },
    };
  };

  const txObj = makeRoot();
  const db = {
    async transaction<T>(fn: (tx: object) => Promise<T>): Promise<T> {
      return fn(txObj);
    },
    ...txObj,
  };

  return {
    db,
    calls,
    setParentSelectResult(rows) {
      parentSelect = rows;
    },
    setChildUpdateResult(rows) {
      childUpdate = rows;
    },
    setChildDeleteResult(rows) {
      childDelete = rows;
      childDeleteSet = true;
    },
    failNextInsert(err) {
      insertErrorQueue.push(err);
    },
    failNextUpdate(err) {
      updateErrorQueue.push(err);
    },
    queueSelect(rows) {
      selectQueue.push(rows);
    },
    setConnectionsReturning(rows) {
      // Used by both deleteConnection (DELETE…RETURNING on connections)
      // and setTableAccess / addDatabase / removeDatabase / renameDatabase
      // (SELECT id FROM connections for the ownership check). Same
      // fixture data, different read paths in the post-0009 (multi-DB)
      // shape; populating both keeps the existing tests working without
      // forcing each call site to pick the right setter.
      deletedConnections = rows;
      parentSelect = rows.map((r) => ({ ...r, region: "eu" }));
    },
  };
}

// Note: we use vi.importActual rather than the (orig) callback overload of
// vi.mock — vitest supports both, but vi.importActual works uniformly across
// runners and is the modern API. The mock factory replaces a few exports
// (getDb, encryptDsn) while preserving the rest (the schema tables we
// import as values).
vi.mock("@midplane-cloud/db", async () => {
  const real = await vi.importActual<typeof import("@midplane-cloud/db")>(
    "@midplane-cloud/db",
  );
  return {
    ...real,
    getDb: (_region: "eu" | "us") => handle.db,
  };
});

vi.mock("@midplane-cloud/kms", async () => {
  const real = await vi.importActual<typeof import("@midplane-cloud/kms")>(
    "@midplane-cloud/kms",
  );
  return {
    ...real,
    // Bypass KMS — return deterministic ciphertext shape so we can assert
    // the rotation path stamps the new ciphertext + key id onto the row.
    encryptDsn: vi.fn(async (_ctx, plaintext: string) => ({
      ciphertext: Buffer.from(`ct:${plaintext}`),
      kmsKeyId: `env:eu:${plaintext.length}`,
    })),
    makeKmsContext: () => ({ mode: "env", envKeys: {}, kmsKeys: {} }),
  };
});

beforeEach(() => {
  handle = makeFakeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

const customer = {
  // ULID literal — emitConfigAuditRow validates customer.id matches the
  // ULID alphabet before SET LOCAL inlines it into the SQL string. The
  // production resolver (currentCustomer) only ever returns rows whose
  // ids were generated by ulid(), but the test customer fixture has to
  // satisfy the same shape.
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  clerkOrgId: "org_clerk-1",
  email: "u@e.test",
  region: "eu" as const,
  createdAt: new Date(),
};

describe("normalizeName", () => {
  it("trims whitespace, collapses empty to null, clamps overlong input", async () => {
    const { normalizeName, MAX_CONNECTION_NAME_LENGTH } = await import(
      "../src/lib/connections.ts"
    );
    expect(normalizeName(null)).toBe(null);
    expect(normalizeName(undefined)).toBe(null);
    expect(normalizeName("   ")).toBe(null);
    expect(normalizeName("  prod db  ")).toBe("prod db");
    const long = "x".repeat(MAX_CONNECTION_NAME_LENGTH + 20);
    expect(normalizeName(long)).toHaveLength(MAX_CONNECTION_NAME_LENGTH);
  });
});

describe("deleteConnection", () => {
  it("returns null when nothing was deleted (no cursor delete fires)", async () => {
    handle.setConnectionsReturning([]);
    const { connections, indexerCursors } = await import("@midplane-cloud/db");
    const { deleteConnection } = await import("../src/lib/connections.ts");
    const result = await deleteConnection(customer, "missing-id");
    expect(result).toBeNull();
    expect(handle.calls.some((c) => c.table === connections)).toBe(true);
    expect(handle.calls.some((c) => c.table === indexerCursors)).toBe(false);
  });

  it("deletes the matching indexer_cursors row when a connection is removed", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    const { indexerCursors } = await import("@midplane-cloud/db");
    const { deleteConnection } = await import("../src/lib/connections.ts");
    const result = await deleteConnection(customer, "conn-1");
    expect(result).toMatchObject({ id: "conn-1" });
    const cursorDelete = handle.calls.find(
      (c) => c.table === indexerCursors,
    );
    expect(cursorDelete, "indexer_cursors delete must fire").toBeDefined();
  });
});

interface CacheSpy {
  invalidate: ReturnType<typeof vi.fn>;
}
interface RegistrySpy {
  invalidate: ReturnType<typeof vi.fn>;
}

function makeCaches(overrides?: {
  cache?: Partial<CacheSpy>;
  registry?: Partial<RegistrySpy>;
}) {
  const cache: CacheSpy = {
    invalidate: vi.fn(),
    ...overrides?.cache,
  };
  const registry: RegistrySpy = {
    invalidate: vi.fn(async () => undefined),
    ...overrides?.registry,
  };
  return { cache, registry };
}

describe("rotateConnection", () => {
  it("happy path: updates connection_databases ciphertext + invalidates per-credential cache + registry", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", region: "eu" },
    ]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const { rotateConnection } = await import("../src/lib/connections.ts");
    const caches = makeCaches();

    const result = await rotateConnection(
      customer,
      "conn-1",
      "postgres://u:p@host:5432/db",
      caches,
    );

    expect(result).toEqual({
      id: "conn-1",
      region: "eu",
    });

    // The ciphertext / kms_key_id / rotated_at land on the CHILD row,
    // not the parent — the parent `connections` row is identity only
    // post-0008.
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(
      childUpdate,
      "rotation must issue UPDATE on connection_databases",
    ).toBeDefined();
    const set = childUpdate?.set as
      | { encryptedDsn: Buffer; kmsKeyId: string; rotatedAt: Date }
      | undefined;
    expect(set?.encryptedDsn).toEqual(
      Buffer.from("ct:postgres://u:p@host:5432/db"),
    );
    expect(set?.kmsKeyId).toBe(`env:eu:${"postgres://u:p@host:5432/db".length}`);
    expect(set?.rotatedAt).toBeInstanceOf(Date);

    // Cache invalidation now keys per-credential (the child id), so a
    // future multi-DB rotation only invalidates the rotated credential.
    expect(caches.cache.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.cache.invalidate).toHaveBeenCalledWith("cdb-main-1", "eu");
    // PR2 of mcp_url_auth_security: ContainerRegistry keys on the parent
    // connection id, not the (now-removed) mcp_token.
    expect(caches.registry.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledWith("conn-1");
  });

  it("404 path: returns null and skips both invalidations when ownership mismatches", async () => {
    handle.setParentSelectResult([]);
    const { rotateConnection } = await import("../src/lib/connections.ts");
    const caches = makeCaches();

    const result = await rotateConnection(
      customer,
      "conn-other-customer",
      "postgres://u:p@host:5432/db",
      caches,
    );

    expect(result).toBeNull();
    expect(caches.cache.invalidate).not.toHaveBeenCalled();
    expect(caches.registry.invalidate).not.toHaveBeenCalled();
  });

  it("failure isolation: cache.invalidate throwing does NOT prevent registry.invalidate from running", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", region: "eu" },
    ]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { rotateConnection } = await import("../src/lib/connections.ts");
    const caches = makeCaches({
      cache: {
        invalidate: vi.fn(() => {
          throw new Error("cache exploded");
        }),
      },
    });
    // Suppress the expected console.error from the rotation path.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await rotateConnection(
      customer,
      "conn-1",
      "postgres://u:p@host:5432/db",
      caches,
    );

    // Rotation reports success — DB is committed; the cache failure is
    // logged but not surfaced (caches catch up at next idle expiry).
    expect(result).toEqual({
      id: "conn-1",
      region: "eu",
    });
    expect(caches.cache.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledWith("conn-1");
    errorSpy.mockRestore();
  });
});

interface PolicyDepsSpy {
  registry: { invalidate: ReturnType<typeof vi.fn> };
  pushPolicy: ReturnType<typeof vi.fn>;
}

function makePolicyDeps(
  pushResult: unknown | (() => unknown | Promise<unknown>) = {
    delivered: true,
  },
): PolicyDepsSpy {
  return {
    registry: { invalidate: vi.fn(async () => undefined) },
    pushPolicy: vi.fn(async () => {
      if (typeof pushResult === "function") {
        return (pushResult as () => unknown)();
      }
      return pushResult;
    }),
  };
}

const goodPolicy = {
  default: "read",
  tables: { "public.users": "deny" },
} as const;

// Inert tenant_scope envelope reused across fixtures. Mirrors the
// EMPTY_TENANT_SCOPE constant exported from @midplane-cloud/db.
const inertScope = { column: null, overrides: {}, exempt: [] };

const ACTOR = "user_clerk-actor";

describe("setTableAccess", () => {
  // Shape returned by the in-txn siblings select. Mirrors the post-update
  // state, since Postgres reads see writes within the same txn.
  const mainSibling = {
    id: "cdb-main-1",
    name: "main",
    tableAccess: goodPolicy,
    tenantScope: inertScope,
  };
  // Expected pushPolicy second arg: the multi-DB body remapped from
  // siblings rows. PR-A bumps OSS to 0.4.0; the legacy single-section
  // body is rejected on every cloud-managed engine, so the helper now
  // serializes the full DatabaseEntry[] shape.
  const mainEntry = {
    name: "main",
    connectionDatabaseId: "cdb-main-1",
    tableAccess: goodPolicy,
    tenantScope: inertScope,
  };

  it("happy path: writes Postgres, hot-reloads engine, does NOT invalidate", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [mainEntry]);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("idle-agent path: delivered=false short-circuits without invalidate", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: false });

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledTimes(1);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejected (400): throws EnginePolicyRejected, does NOT fall back to invalidate", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess, EnginePolicyRejected } = await import(
      "../src/lib/connections.ts"
    );
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "tables.foo: must be one of …" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setTableAccess(customer, "conn-1", goodPolicy, deps, ACTOR),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("network failure: falls back to registry.invalidate (fail-soft, like rotateConnection)", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps(() => {
      throw new Error("ECONNREFUSED");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
    errorSpy.mockRestore();
  });

  it("dbName not found: returns null when the named child doesn't exist on the connection", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([]); // child UPDATE matches 0 rows
    // No siblings queue entry needed — the txn short-circuits before
    // the siblings select runs.
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
      "analytics",
    );

    expect(result).toBeNull();
    // Engine push must NOT fire when the DB write didn't land.
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("explicit dbName: writes to the named child, pushes policy with same token", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-analytics-1" }]);
    handle.queueSelect([
      {
        id: "cdb-analytics-1",
        name: "analytics",
        tableAccess: goodPolicy,
        tenantScope: inertScope,
      },
    ]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
      "analytics",
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "analytics",
        connectionDatabaseId: "cdb-analytics-1",
        tableAccess: goodPolicy,
        tenantScope: inertScope,
      },
    ]);
    // The child UPDATE's where-clause must reference the explicit dbName,
    // not "main". We can't introspect the drizzle expression directly,
    // but we can confirm the update fired against connection_databases.
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(childUpdate).toBeDefined();
  });

  it("multi-DB connection: pushPolicy body lists every sibling so OSS doesn't drop them", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    // Edited DB ("main") plus an untouched sibling ("analytics"). OSS
    // 0.4.0 drops any DB absent from the body, so the cloud must restate
    // every DB on the connection on every hot-reload.
    handle.queueSelect([
      mainSibling,
      {
        id: "cdb-analytics-1",
        name: "analytics",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: {
          column: "tenant_id",
          overrides: { orders: "org_id" },
          exempt: [],
        },
      },
    ]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      mainEntry,
      {
        name: "analytics",
        connectionDatabaseId: "cdb-analytics-1",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: {
          column: "tenant_id",
          overrides: { orders: "org_id" },
          exempt: [],
        },
      },
    ]);
  });

  it("404 path: returns null and skips push/invalidate when ownership mismatches", async () => {
    handle.queueSelect([]); // parent ownership check returns no row
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    const result = await setTableAccess(
      customer,
      "conn-other",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toBeNull();
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejects malformed policies before touching Postgres", async () => {
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    await expect(
      setTableAccess(
        customer,
        "conn-1",
        { default: "bogus", tables: {} } as unknown as Parameters<
          typeof setTableAccess
        >[2],
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid policy/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.pushPolicy).not.toHaveBeenCalled();
  });

  it("emits POLICY_CHANGED audit row stamped with the actor", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    await setTableAccess(customer, "conn-1", goodPolicy, deps, ACTOR);

    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "POLICY_CHANGED audit row must be inserted").toBeDefined();
    const row = audit?.set as
      | {
          eventType: string;
          customerId: string;
          tenantId: string;
          actorClerkUserId: string;
          payload: {
            connection_id: string;
            database_name: string;
            policy: typeof goodPolicy;
          };
        }
      | undefined;
    expect(row?.eventType).toBe("POLICY_CHANGED");
    expect(row?.customerId).toBe(customer.id);
    expect(row?.tenantId).toBe("conn-1");
    expect(row?.actorClerkUserId).toBe(ACTOR);
    expect(row?.payload.connection_id).toBe("conn-1");
    expect(row?.payload.database_name).toBe("main");

    // RLS bind: the audit insert must run inside a txn that first
    // executed SET LOCAL app.customer_id. Without that, RLS (once a
    // non-bypass app role is in use) rejects the insert and we silently
    // lose the audit row.
    const setLocal = handle.calls.find(
      (c) => c.op === "execute" && String(c.set).includes("SET LOCAL app.customer_id"),
    );
    expect(setLocal, "audit insert must bind app.customer_id via SET LOCAL").toBeDefined();
  });

  it("stamps database column with dbName for non-main DBs (preserves /audit per-DB filter)", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-analytics-1" }]);
    handle.queueSelect([
      {
        id: "cdb-analytics-1",
        name: "analytics",
        tableAccess: goodPolicy,
        tenantScope: inertScope,
      },
    ]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    await setTableAccess(customer, "conn-1", goodPolicy, deps, ACTOR, "analytics");

    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    const row = audit?.set as { database: string } | undefined;
    expect(row?.database, "audit.database must equal dbName, not the 'main' column default").toBe(
      "analytics",
    );
  });

  it("does NOT emit POLICY_CHANGED when engine rejects the policy", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess, EnginePolicyRejected } = await import(
      "../src/lib/connections.ts"
    );
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "tables.foo: must be one of …" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setTableAccess(customer, "conn-1", goodPolicy, deps, ACTOR),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "audit row must NOT be written for rejected policies").toBeUndefined();
    errorSpy.mockRestore();
  });
});

describe("setTenantScope", () => {
  // Sibling-select returns the post-update row, so the new config shape
  // (column + overrides + exempt) is what the engine receives.
  const strictScope = {
    column: "tenant_id",
    overrides: { orders: "org_id" },
    exempt: ["audit_log"],
  };
  const mainSibling = {
    id: "cdb-main-1",
    name: "main",
    tableAccess: { default: "read", tables: {} },
    tenantScope: strictScope,
  };

  it("happy path: writes Postgres, hot-reloads engine with the strict-mode body", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTenantScope(customer, "conn-1", strictScope, deps, ACTOR);

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        connectionDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: strictScope,
      },
    ]);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("multi-DB connection: restates every sibling so OSS doesn't drop the untouched one", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([
      mainSibling,
      {
        id: "cdb-analytics-1",
        name: "analytics",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: inertScope,
      },
    ]);
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: true });

    await setTenantScope(customer, "conn-1", strictScope, deps, ACTOR);

    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        connectionDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: strictScope,
      },
      {
        name: "analytics",
        connectionDatabaseId: "cdb-analytics-1",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: inertScope,
      },
    ]);
  });

  it("inert envelope: persists EMPTY_TENANT_SCOPE (= tenant_scope disabled on this DB)", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([
      {
        id: "cdb-main-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
        tenantScope: inertScope,
      },
    ]);
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: true });

    await setTenantScope(customer, "conn-1", inertScope, deps, ACTOR);

    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(childUpdate).toBeDefined();
    const set = childUpdate?.set as
      | { tenantScope: typeof inertScope }
      | undefined;
    expect(set?.tenantScope).toEqual(inertScope);
  });

  it("column=null + overrides-only envelope round-trips through the engine", async () => {
    // The 0012 backfill wraps pre-0.5.0 flat maps into {column:null,
    // overrides:<old>, exempt:[]} so existing customers keep working
    // without a forced default-column decision.
    const overridesOnly = {
      column: null,
      overrides: { orders: "tenant_id" },
      exempt: [],
    };
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([
      {
        id: "cdb-main-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
        tenantScope: overridesOnly,
      },
    ]);
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: true });

    await setTenantScope(customer, "conn-1", overridesOnly, deps, ACTOR);

    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        connectionDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: overridesOnly,
      },
    ]);
  });

  it("rejected (400): throws EnginePolicyRejected and does NOT fall back to invalidate", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope, EnginePolicyRejected } = await import(
      "../src/lib/connections.ts"
    );
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "tenant_scope.overrides.orders: …" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setTenantScope(customer, "conn-1", strictScope, deps, ACTOR),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("network failure: falls back to registry.invalidate (fail-soft)", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps(() => {
      throw new Error("ECONNREFUSED");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await setTenantScope(customer, "conn-1", strictScope, deps, ACTOR);
    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
    errorSpy.mockRestore();
  });

  it("dbName not found: returns null when the named child doesn't exist on the connection", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([]); // 0 rows matched the dbName
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    const result = await setTenantScope(
      customer,
      "conn-1",
      strictScope,
      deps,
      ACTOR,
      "ghost-db",
    );

    expect(result).toBeNull();
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("404 path: returns null and skips push/invalidate when ownership mismatches", async () => {
    handle.queueSelect([]); // parent ownership check returns no row
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    const result = await setTenantScope(
      customer,
      "conn-other",
      strictScope,
      deps,
      ACTOR,
    );

    expect(result).toBeNull();
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejects non-identifier column before touching Postgres", async () => {
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: "bad name", overrides: {}, exempt: [] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.pushPolicy).not.toHaveBeenCalled();
  });

  it("accepts schema-qualified table names in overrides + exempt (autocomplete returns public.users)", async () => {
    // The shared TableNameInput fills the field from
    // information_schema as `schema.table`. tenant_scope keys must
    // accept that shape — otherwise a save with an autocompleted value
    // would fail before the engine even sees it.
    const schemaScope = {
      column: "tenant_id",
      overrides: { "public.users": "customer_id" },
      exempt: ["public.regions"],
    };
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([
      {
        id: "cdb-main-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
        tenantScope: schemaScope,
      },
    ]);
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTenantScope(customer, "conn-1", schemaScope, deps, ACTOR);

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        connectionDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: schemaScope,
      },
    ]);
  });

  it("rejects schema-qualified default column (columns are single identifiers, only tables can be schema-qualified)", async () => {
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();
    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: "public.tenant_id", overrides: {}, exempt: [] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
    expect(handle.calls).toHaveLength(0);
  });

  it("rejects non-identifier override keys / values", async () => {
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: null, overrides: { "bad name": "tenant_id" }, exempt: [] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: null, overrides: { orders: "tenant id" }, exempt: [] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
    expect(handle.calls).toHaveLength(0);
  });

  it("rejects non-identifier exempt entries", async () => {
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: "tenant_id", overrides: {}, exempt: ["bad name"] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
  });

  it("emits TENANT_SCOPE_CHANGED audit row stamped with the actor", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope } = await import("../src/lib/connections.ts");
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    await setTenantScope(customer, "conn-1", strictScope, deps, ACTOR);

    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "TENANT_SCOPE_CHANGED audit row must be inserted").toBeDefined();
    const row = audit?.set as
      | {
          eventType: string;
          customerId: string;
          tenantId: string;
          actorClerkUserId: string;
          payload: {
            connection_id: string;
            database_name: string;
            config: typeof strictScope;
          };
        }
      | undefined;
    expect(row?.eventType).toBe("TENANT_SCOPE_CHANGED");
    expect(row?.customerId).toBe(customer.id);
    expect(row?.tenantId).toBe("conn-1");
    expect(row?.actorClerkUserId).toBe(ACTOR);
    expect(row?.payload.connection_id).toBe("conn-1");
    expect(row?.payload.database_name).toBe("main");
    expect(row?.payload.config).toEqual(strictScope);

    // RLS bind — see the matching assertion in the POLICY_CHANGED test.
    const setLocal = handle.calls.find(
      (c) => c.op === "execute" && String(c.set).includes("SET LOCAL app.customer_id"),
    );
    expect(setLocal, "audit insert must bind app.customer_id via SET LOCAL").toBeDefined();
  });

  it("does NOT emit TENANT_SCOPE_CHANGED when engine rejects the config", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope, EnginePolicyRejected } = await import(
      "../src/lib/connections.ts"
    );
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "tenant_scope.column: must match identifier regex" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setTenantScope(customer, "conn-1", strictScope, deps, ACTOR),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "audit row must NOT be written for rejected configs").toBeUndefined();
    errorSpy.mockRestore();
  });
});

describe("rotateConnection with explicit dbName", () => {
  it("rotates the named child, not main, when dbName is passed", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", region: "eu" },
    ]);
    handle.setChildUpdateResult([{ id: "cdb-analytics-1" }]);
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const { rotateConnection } = await import("../src/lib/connections.ts");
    const caches = makeCaches();

    const result = await rotateConnection(
      customer,
      "conn-1",
      "postgres://u:p@host:5432/analytics",
      caches,
      "analytics",
    );

    expect(result).toEqual({
      id: "conn-1",
      region: "eu",
    });
    // Cache invalidation keys on the rotated child id, so a sibling DB's
    // DecryptCache entry stays warm. The container is invalidated by
    // connection id (PR2 of mcp_url_auth_security — was mcpToken).
    expect(caches.cache.invalidate).toHaveBeenCalledWith(
      "cdb-analytics-1",
      "eu",
    );
    expect(caches.registry.invalidate).toHaveBeenCalledWith("conn-1");
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(childUpdate).toBeDefined();
  });

  it("returns null and skips invalidations when the named child does not exist", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", region: "eu" },
    ]);
    handle.setChildUpdateResult([]); // 0 rows matched the dbName
    const { rotateConnection } = await import("../src/lib/connections.ts");
    const caches = makeCaches();

    const result = await rotateConnection(
      customer,
      "conn-1",
      "postgres://u:p@host:5432/db",
      caches,
      "ghost-db",
    );

    expect(result).toBeNull();
    expect(caches.cache.invalidate).not.toHaveBeenCalled();
    expect(caches.registry.invalidate).not.toHaveBeenCalled();
  });
});

describe("isValidDatabaseName", () => {
  it("accepts the OSS DB_NAME_RE shape", async () => {
    const { isValidDatabaseName } = await import("../src/lib/connections.ts");
    expect(isValidDatabaseName("main")).toBe(true);
    expect(isValidDatabaseName("a")).toBe(true);
    expect(isValidDatabaseName("analytics")).toBe(true);
    expect(isValidDatabaseName("db_with-mix3d")).toBe(true);
    expect(isValidDatabaseName("a".repeat(32))).toBe(true);
  });

  it("rejects invalid shapes (caps, leading digit, too long, empty, non-string)", async () => {
    const { isValidDatabaseName } = await import("../src/lib/connections.ts");
    expect(isValidDatabaseName("")).toBe(false);
    expect(isValidDatabaseName("Main")).toBe(false);
    expect(isValidDatabaseName("1main")).toBe(false);
    expect(isValidDatabaseName("_leading")).toBe(false);
    expect(isValidDatabaseName("with space")).toBe(false);
    expect(isValidDatabaseName("a".repeat(33))).toBe(false);
    expect(isValidDatabaseName(null)).toBe(false);
    expect(isValidDatabaseName(undefined)).toBe(false);
  });
});

interface MutationDepsSpy {
  registry: { invalidate: ReturnType<typeof vi.fn> };
}

function makeMutationDeps(): MutationDepsSpy {
  return { registry: { invalidate: vi.fn(async () => undefined) } };
}

describe("addDatabase", () => {
  it("happy path: encrypts DSN, inserts child row, invalidates registry", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]); // parent ownership
    handle.queueSelect([]); // sibling-collision check returns empty
    const { addDatabase } = await import("../src/lib/connections.ts");
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await addDatabase(
      customer,
      "conn-1",
      "analytics",
      "postgres://u:p@host:5432/analytics",
      "read",
      deps,
    );

    expect(result).not.toBeNull();
    // PR2 of mcp_url_auth_security: addDatabase returns { id, connectionId }.
    // `id` is the freshly-minted child id (a ULID); `connectionId` is the
    // parent connection id used by the registry invalidation below.
    expect(result?.connectionId).toBe("conn-1");
    expect(typeof result?.id).toBe("string");
    expect(result?.id).not.toBe("conn-1"); // child id is fresh

    const insert = handle.calls.find(
      (c) => c.op === "insert" && c.table === connectionDatabases,
    );
    expect(insert, "must INSERT into connection_databases").toBeDefined();
    const set = insert?.set as
      | { name: string; encryptedDsn: Buffer; tableAccess: { default: string } }
      | undefined;
    expect(set?.name).toBe("analytics");
    expect(set?.encryptedDsn).toEqual(
      Buffer.from("ct:postgres://u:p@host:5432/analytics"),
    );
    expect(set?.tableAccess.default).toBe("read");
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
  });

  it("name collision: throws DatabaseNameTaken without inserting or invalidating", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ id: "cdb-existing" }]); // sibling already owns the name
    const { addDatabase, DatabaseNameTaken } = await import(
      "../src/lib/connections.ts"
    );
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    await expect(
      addDatabase(
        customer,
        "conn-1",
        "analytics",
        "postgres://u:p@host:5432/db",
        "read",
        deps,
      ),
    ).rejects.toBeInstanceOf(DatabaseNameTaken);

    const insert = handle.calls.find(
      (c) => c.op === "insert" && c.table === connectionDatabases,
    );
    expect(insert, "no insert when name is taken").toBeUndefined();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("404 path: returns null when ownership mismatches", async () => {
    handle.setConnectionsReturning([]); // parent select returns empty
    const { addDatabase } = await import("../src/lib/connections.ts");
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await addDatabase(
      customer,
      "conn-other",
      "analytics",
      "postgres://u:p@host:5432/db",
      "read",
      deps,
    );

    expect(result).toBeNull();
    const insert = handle.calls.find(
      (c) => c.op === "insert" && c.table === connectionDatabases,
    );
    expect(insert).toBeUndefined();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejects invalid dbName before touching KMS / Postgres", async () => {
    const { addDatabase } = await import("../src/lib/connections.ts");
    const deps = makeMutationDeps();

    await expect(
      addDatabase(
        customer,
        "conn-1",
        "Bad Name", // caps + space
        "postgres://u:p@host:5432/db",
        "read",
        deps,
      ),
    ).rejects.toThrow(/invalid database name/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("translates a Postgres unique-violation at insert into DatabaseNameTaken", async () => {
    // Belt-and-suspenders: the FOR UPDATE lock plus the in-txn
    // pre-check should make this unreachable, but the outer catch
    // must still translate a raw 23505 into the typed error so the
    // dashboard action keeps working under any future race.
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([]); // pre-check: no collision visible yet
    handle.failNextInsert({
      code: "23505",
      constraint_name: "connection_databases_connection_name_uq",
      message: "duplicate key value violates unique constraint",
    });
    const { addDatabase, DatabaseNameTaken } = await import(
      "../src/lib/connections.ts"
    );
    const deps = makeMutationDeps();

    await expect(
      addDatabase(
        customer,
        "conn-1",
        "analytics",
        "postgres://u:p@host:5432/db",
        "read",
        deps,
      ),
    ).rejects.toBeInstanceOf(DatabaseNameTaken);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rethrows non-unique driver errors as-is", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([]);
    const realFailure = new Error("connection terminated unexpectedly");
    handle.failNextInsert(realFailure);
    const { addDatabase } = await import("../src/lib/connections.ts");
    const deps = makeMutationDeps();

    await expect(
      addDatabase(
        customer,
        "conn-1",
        "analytics",
        "postgres://u:p@host:5432/db",
        "read",
        deps,
      ),
    ).rejects.toBe(realFailure);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });
});

describe("removeDatabase", () => {
  it("happy path: deletes the named child, invalidates registry", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]); // ownership
    handle.queueSelect([{ id: "cdb-main" }, { id: "cdb-analytics" }]); // 2 siblings
    handle.setChildDeleteResult([{ id: "cdb-analytics" }]);
    const { removeDatabase } = await import("../src/lib/connections.ts");
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await removeDatabase(customer, "conn-1", "analytics", deps);

    expect(result).toMatchObject({ id: "conn-1" });
    const childDelete = handle.calls.find(
      (c) => c.op === "delete" && c.table === connectionDatabases,
    );
    expect(childDelete).toBeDefined();
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
  });

  it("blocks the last database: throws LastDatabaseProtected without deleting", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ id: "cdb-main" }]); // only 1 sibling — last DB
    const { removeDatabase, LastDatabaseProtected } = await import(
      "../src/lib/connections.ts"
    );
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    await expect(
      removeDatabase(customer, "conn-1", "main", deps),
    ).rejects.toBeInstanceOf(LastDatabaseProtected);

    const childDelete = handle.calls.find(
      (c) => c.op === "delete" && c.table === connectionDatabases,
    );
    expect(childDelete, "no delete when blocked by last-DB rule").toBeUndefined();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("404 path: returns null when ownership mismatches", async () => {
    handle.setConnectionsReturning([]);
    const { removeDatabase } = await import("../src/lib/connections.ts");
    const deps = makeMutationDeps();

    const result = await removeDatabase(customer, "conn-other", "main", deps);

    expect(result).toBeNull();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("dbName not on connection: returns null after attempting delete", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ id: "cdb-main" }, { id: "cdb-analytics" }]); // 2 siblings → not blocked
    handle.setChildDeleteResult([]); // delete matched 0 rows
    const { removeDatabase } = await import("../src/lib/connections.ts");
    const deps = makeMutationDeps();

    const result = await removeDatabase(customer, "conn-1", "ghost-db", deps);

    expect(result).toBeNull();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });
});

describe("renameDatabase", () => {
  it("happy path: updates name, invalidates registry (forces container restart)", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([]); // no sibling collision
    handle.setChildUpdateResult([{ id: "cdb-analytics-1" }]);
    const { renameDatabase } = await import("../src/lib/connections.ts");
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await renameDatabase(
      customer,
      "conn-1",
      "analytics",
      "warehouse",
      deps,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(childUpdate).toBeDefined();
    const set = childUpdate?.set as { name: string } | undefined;
    expect(set?.name).toBe("warehouse");
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
  });

  it("name collision: throws DatabaseNameTaken without updating or invalidating", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ id: "cdb-other" }]); // sibling already owns "warehouse"
    const { renameDatabase, DatabaseNameTaken } = await import(
      "../src/lib/connections.ts"
    );
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    await expect(
      renameDatabase(customer, "conn-1", "analytics", "warehouse", deps),
    ).rejects.toBeInstanceOf(DatabaseNameTaken);

    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(childUpdate).toBeUndefined();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("no-op rename (oldName === newName): short-circuits without container restart", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    const { renameDatabase } = await import("../src/lib/connections.ts");
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await renameDatabase(
      customer,
      "conn-1",
      "main",
      "main",
      deps,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    // No update on connection_databases — the rename is a no-op.
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(childUpdate).toBeUndefined();
    // No restart needed for a no-op.
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("404 path: returns null when ownership mismatches", async () => {
    handle.setConnectionsReturning([]);
    const { renameDatabase } = await import("../src/lib/connections.ts");
    const deps = makeMutationDeps();

    const result = await renameDatabase(
      customer,
      "conn-other",
      "main",
      "warehouse",
      deps,
    );

    expect(result).toBeNull();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejects invalid newName before touching Postgres", async () => {
    const { renameDatabase } = await import("../src/lib/connections.ts");
    const deps = makeMutationDeps();

    await expect(
      renameDatabase(customer, "conn-1", "main", "Bad Name", deps),
    ).rejects.toThrow(/invalid database name/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("source dbName missing: returns null, no invalidate", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([]); // no sibling collision on newName
    handle.setChildUpdateResult([]); // update matched 0 rows
    const { renameDatabase } = await import("../src/lib/connections.ts");
    const deps = makeMutationDeps();

    const result = await renameDatabase(
      customer,
      "conn-1",
      "ghost",
      "warehouse",
      deps,
    );

    expect(result).toBeNull();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("translates a Postgres unique-violation at update into DatabaseNameTaken", async () => {
    handle.setConnectionsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([]); // pre-check passes
    handle.failNextUpdate({
      code: "23505",
      constraint_name: "connection_databases_connection_name_uq",
      message: "duplicate key value violates unique constraint",
    });
    const { renameDatabase, DatabaseNameTaken } = await import(
      "../src/lib/connections.ts"
    );
    const deps = makeMutationDeps();

    await expect(
      renameDatabase(customer, "conn-1", "analytics", "warehouse", deps),
    ).rejects.toBeInstanceOf(DatabaseNameTaken);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });
});

describe("getConnectionWithDatabase", () => {
  it("returns parent + named child when both exist", async () => {
    handle.queueSelect([
      { id: "conn-1", customerId: customer.id, region: "eu" },
    ]);
    handle.queueSelect([
      { id: "cdb-analytics-1", connectionId: "conn-1", name: "analytics" },
    ]);
    const { getConnectionWithDatabase } = await import(
      "../src/lib/connections.ts"
    );

    const result = await getConnectionWithDatabase(
      customer,
      "conn-1",
      "analytics",
    );

    expect(result).not.toBeNull();
    expect(result?.connection.id).toBe("conn-1");
    expect(result?.database.name).toBe("analytics");
  });

  it("returns null when parent missing", async () => {
    handle.queueSelect([]);
    const { getConnectionWithDatabase } = await import(
      "../src/lib/connections.ts"
    );

    const result = await getConnectionWithDatabase(customer, "conn-1", "main");
    expect(result).toBeNull();
  });

  it("returns null when child missing", async () => {
    handle.queueSelect([
      { id: "conn-1", customerId: customer.id, region: "eu" },
    ]);
    handle.queueSelect([]);
    const { getConnectionWithDatabase } = await import(
      "../src/lib/connections.ts"
    );

    const result = await getConnectionWithDatabase(customer, "conn-1", "ghost");
    expect(result).toBeNull();
  });
});

// listDashboardConnections + getDashboardFreshness exercise three
// reads (parents + cursor join, audit max-ts aggregate, children
// IN-list). Promise.all([parentsChain, lastQueryByDatabase()]) doesn't
// drain queries in source order because the inner `await` inside
// lastQueryByDatabase schedules its microtask BEFORE Promise.all
// schedules its iteration microtasks. The actual drain order against
// the fake's selectQueue is:
//   1. audit aggregate (inner await fires first)
//   2. parents (Promise.all microtask fires next)
//   3. children (sequential after Promise.all resolves)
// Tests queue rows in that order.

describe("listDashboardConnections", () => {
  it("plumbs per-DB lastQueryAt from audit_events_index into each row", async () => {
    const indexedAt = new Date("2026-04-30T10:00:00Z");
    const mainQueryAt = new Date("2026-04-30T11:30:00Z");
    const analyticsQueryAt = new Date("2026-04-30T11:45:00Z");
    // 1) audit aggregate (inner await fires first)
    handle.queueSelect([
      { database: "main", lastQueryAt: mainQueryAt },
      { database: "analytics", lastQueryAt: analyticsQueryAt },
    ]);
    // 2) parents query (Promise.all microtask)
    handle.queueSelect([
      {
        connection: {
          id: "conn-1",
          customerId: customer.id,
          region: "eu",
          name: "prod",
          createdAt: new Date(),
        },
        lastIndexedAt: indexedAt,
        lastErrorAt: null,
      },
    ]);
    // 3) children query (sequential after Promise.all)
    handle.queueSelect([
      {
        id: "cdb-main",
        connectionId: "conn-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
      },
      {
        id: "cdb-analytics",
        connectionId: "conn-1",
        name: "analytics",
        tableAccess: { default: "deny", tables: {} },
      },
    ]);
    const { listDashboardConnections } = await import(
      "../src/lib/connections.ts"
    );

    const rows = await listDashboardConnections(customer);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.cursor.lastIndexedAt).toEqual(indexedAt);
    expect(rows[0]!.databases).toHaveLength(2);
    const byName = new Map(rows[0]!.databases.map((d) => [d.name, d]));
    expect(byName.get("main")?.lastQueryAt).toEqual(mainQueryAt);
    expect(byName.get("analytics")?.lastQueryAt).toEqual(analyticsQueryAt);
  });

  it("returns lastQueryAt: null when audit aggregate has no row for that DB", async () => {
    handle.queueSelect([]); // audit: no rows yet (inner await first)
    handle.queueSelect([
      {
        connection: {
          id: "conn-1",
          customerId: customer.id,
          region: "eu",
          name: null,
          createdAt: new Date(),
        },
        lastIndexedAt: null,
        lastErrorAt: null,
      },
    ]);
    handle.queueSelect([
      {
        id: "cdb-main",
        connectionId: "conn-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
      },
    ]);
    const { listDashboardConnections } = await import(
      "../src/lib/connections.ts"
    );

    const rows = await listDashboardConnections(customer);
    expect(rows[0]!.databases[0]!.lastQueryAt).toBeNull();
  });

  it("coerces driver-returned ISO strings on the audit aggregate to real Dates", async () => {
    const isoString = "2026-04-30T11:30:00.000Z";
    handle.queueSelect([{ database: "main", lastQueryAt: isoString }]);
    handle.queueSelect([
      {
        connection: {
          id: "conn-1",
          customerId: customer.id,
          region: "eu",
          name: null,
          createdAt: new Date(),
        },
        lastIndexedAt: null,
        lastErrorAt: null,
      },
    ]);
    handle.queueSelect([
      {
        id: "cdb-main",
        connectionId: "conn-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
      },
    ]);
    const { listDashboardConnections } = await import(
      "../src/lib/connections.ts"
    );

    const rows = await listDashboardConnections(customer);
    expect(rows[0]!.databases[0]!.lastQueryAt).toBeInstanceOf(Date);
    expect((rows[0]!.databases[0]!.lastQueryAt as Date).toISOString()).toBe(
      isoString,
    );
  });
});

describe("getDashboardFreshness", () => {
  it("returns the slim freshness shape without policy / ciphertext", async () => {
    const indexedAt = new Date("2026-04-30T10:00:00Z");
    const mainQueryAt = new Date("2026-04-30T11:30:00Z");
    // Same drain order as listDashboardConnections — audit first, then
    // parents, then children.
    handle.queueSelect([{ database: "main", lastQueryAt: mainQueryAt }]);
    handle.queueSelect([
      {
        id: "conn-1",
        lastIndexedAt: indexedAt,
        lastErrorAt: null,
      },
    ]);
    handle.queueSelect([{ connectionId: "conn-1", name: "main" }]);
    const { getDashboardFreshness } = await import(
      "../src/lib/connections.ts"
    );

    const snapshot = await getDashboardFreshness(customer);

    expect(snapshot.connections).toHaveLength(1);
    const c = snapshot.connections[0]!;
    expect(c.id).toBe("conn-1");
    expect(c.cursor.lastIndexedAt).toEqual(indexedAt);
    expect(c.databases).toEqual([
      { name: "main", lastQueryAt: mainQueryAt },
    ]);
    // PR2 of mcp_url_auth_security: the connection row no longer carries
    // mcp_token at all. Assert it doesn't appear in the freshness payload
    // as a regression guard — if a future schema migration re-introduces
    // a plaintext token column, the polling endpoint should still hold
    // the line.
    expect((c as Record<string, unknown>).mcpToken).toBeUndefined();
  });
});
