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
  op: "delete" | "update" | "select" | "insert";
  table?: unknown;
  set?: unknown;
  where?: unknown;
  returning?: Record<string, unknown>;
}

interface FakeDbHandle {
  db: object;
  calls: DbCall[];
  /** Result of a parent-table select (rotateConnection's ownership check
   *  reads connections, returning {id, mcpToken, region}). */
  setParentSelectResult(
    rows: Array<{ id: string; mcpToken: string; region?: string }>,
  ): void;
  /** Result of a connection_databases UPDATE…RETURNING (rotateConnection
   *  needs the child id to feed DecryptCache.invalidate). */
  setChildUpdateResult(rows: Array<{ id: string }>): void;
  /** Result of a connections DELETE…RETURNING (deleteConnection). */
  setConnectionsReturning(
    rows: Array<{ id: string; mcpToken: string }>,
  ): void;
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
}

let handle: FakeDbHandle;

function makeFakeDb(): FakeDbHandle {
  let parentSelect: Array<{
    id: string;
    mcpToken: string;
    region?: string;
  }> = [];
  let childUpdate: Array<{ id: string }> = [];
  let childDelete: Array<{ id: string }> = [];
  let childDeleteSet = false;
  let deletedConnections: Array<{ id: string; mcpToken: string }> = [];
  const selectQueue: Array<unknown[]> = [];
  const calls: DbCall[] = [];

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
          if (op === "delete") {
            // Distinguish deletes on `connections` (deleteConnection,
            // returning {id, mcpToken}) from deletes on
            // `connection_databases` (removeDatabase, returning {id}).
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
          // {name}), or the tenant_scope mappings. Parent updates on
          // connections only set {name} via renameConnection — but
          // since the test never exercises that simultaneously with a
          // child rename, prefer childUpdate when populated.
          if (
            set &&
            ("encryptedDsn" in set ||
              "tableAccess" in set ||
              "tenantScopeMappings" in set)
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
    queueSelect(rows) {
      selectQueue.push(rows);
    },
    setConnectionsReturning(rows) {
      // Used by both deleteConnection (DELETE…RETURNING on connections)
      // and setTableAccess (SELECT mcpToken FROM connections for the
      // ownership check). Same fixture data, different read paths in the
      // post-0009 (multi-DB) shape; populating both keeps the existing
      // setTableAccess tests working without forcing each call site to
      // pick the right setter.
      deletedConnections = rows;
      parentSelect = rows.map((r) => ({ ...r, region: "fra" }));
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
    getDb: () => handle.db,
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
      kmsKeyId: `env:fra:${plaintext.length}`,
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
  id: "cust-1",
  clerkUserId: "clerk-1",
  email: "u@e.test",
  region: "fra" as const,
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
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    const { indexerCursors } = await import("@midplane-cloud/db");
    const { deleteConnection } = await import("../src/lib/connections.ts");
    const result = await deleteConnection(customer, "conn-1");
    expect(result).toMatchObject({ mcpToken: "tok-1" });
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
      { id: "conn-1", mcpToken: "tok-1", region: "fra" },
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
      mcpToken: "tok-1",
      region: "fra",
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
    expect(set?.kmsKeyId).toBe(`env:fra:${"postgres://u:p@host:5432/db".length}`);
    expect(set?.rotatedAt).toBeInstanceOf(Date);

    // Cache invalidation now keys per-credential (the child id), so a
    // future multi-DB rotation only invalidates the rotated credential.
    expect(caches.cache.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.cache.invalidate).toHaveBeenCalledWith("cdb-main-1", "fra");
    expect(caches.registry.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledWith("tok-1");
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
      { id: "conn-1", mcpToken: "tok-1", region: "fra" },
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
      mcpToken: "tok-1",
      region: "fra",
    });
    expect(caches.cache.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledWith("tok-1");
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

describe("setTableAccess", () => {
  it("happy path: writes Postgres, hot-reloads engine, does NOT invalidate", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTableAccess(customer, "conn-1", goodPolicy, deps);

    expect(result).toMatchObject({ mcpToken: "tok-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("tok-1", goodPolicy);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("idle-agent path: delivered=false short-circuits without invalidate", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps({ delivered: false });

    const result = await setTableAccess(customer, "conn-1", goodPolicy, deps);

    expect(result).toMatchObject({ mcpToken: "tok-1" });
    expect(deps.pushPolicy).toHaveBeenCalledTimes(1);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejected (400): throws EnginePolicyRejected, does NOT fall back to invalidate", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { setTableAccess, EnginePolicyRejected } = await import(
      "../src/lib/connections.ts"
    );
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "tables.foo: must be one of …" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setTableAccess(customer, "conn-1", goodPolicy, deps),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("network failure: falls back to registry.invalidate (fail-soft, like rotateConnection)", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps(() => {
      throw new Error("ECONNREFUSED");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await setTableAccess(customer, "conn-1", goodPolicy, deps);

    expect(result).toMatchObject({ mcpToken: "tok-1" });
    expect(deps.registry.invalidate).toHaveBeenCalledWith("tok-1");
    errorSpy.mockRestore();
  });

  it("dbName not found: returns null when the named child doesn't exist on the connection", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.setChildUpdateResult([]); // child UPDATE matches 0 rows
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      "analytics",
    );

    expect(result).toBeNull();
    // Engine push must NOT fire when the DB write didn't land.
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("explicit dbName: writes to the named child, pushes policy with same token", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.setChildUpdateResult([{ id: "cdb-analytics-1" }]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      "analytics",
    );

    expect(result).toMatchObject({ mcpToken: "tok-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("tok-1", goodPolicy);
    // The child UPDATE's where-clause must reference the explicit dbName,
    // not "main". We can't introspect the drizzle expression directly,
    // but we can confirm the update fired against connection_databases.
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(childUpdate).toBeDefined();
  });

  it("404 path: returns null and skips push/invalidate when ownership mismatches", async () => {
    handle.setConnectionsReturning([]);
    const { setTableAccess } = await import("../src/lib/connections.ts");
    const deps = makePolicyDeps();

    const result = await setTableAccess(
      customer,
      "conn-other",
      goodPolicy,
      deps,
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
      ),
    ).rejects.toThrow(/invalid policy/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.pushPolicy).not.toHaveBeenCalled();
  });
});

describe("rotateConnection with explicit dbName", () => {
  it("rotates the named child, not main, when dbName is passed", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", mcpToken: "tok-1", region: "fra" },
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
      mcpToken: "tok-1",
      region: "fra",
    });
    // Cache invalidation keys on the rotated child id, so a sibling DB's
    // DecryptCache entry stays warm. The container is invalidated by
    // mcpToken (single-token-per-connection) regardless.
    expect(caches.cache.invalidate).toHaveBeenCalledWith(
      "cdb-analytics-1",
      "fra",
    );
    expect(caches.registry.invalidate).toHaveBeenCalledWith("tok-1");
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(childUpdate).toBeDefined();
  });

  it("returns null and skips invalidations when the named child does not exist", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", mcpToken: "tok-1", region: "fra" },
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
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.queueSelect([{ id: "conn-1", mcpToken: "tok-1", region: "fra" }]); // parent ownership
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
    expect(result?.mcpToken).toBe("tok-1");
    expect(typeof result?.id).toBe("string");

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
    expect(deps.registry.invalidate).toHaveBeenCalledWith("tok-1");
  });

  it("name collision: throws DatabaseNameTaken without inserting or invalidating", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.queueSelect([{ id: "conn-1", mcpToken: "tok-1", region: "fra" }]);
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
});

describe("removeDatabase", () => {
  it("happy path: deletes the named child, invalidates registry", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.queueSelect([{ id: "conn-1", mcpToken: "tok-1", region: "fra" }]); // ownership
    handle.queueSelect([{ id: "cdb-main" }, { id: "cdb-analytics" }]); // 2 siblings
    handle.setChildDeleteResult([{ id: "cdb-analytics" }]);
    const { removeDatabase } = await import("../src/lib/connections.ts");
    const { connectionDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await removeDatabase(customer, "conn-1", "analytics", deps);

    expect(result).toMatchObject({ mcpToken: "tok-1" });
    const childDelete = handle.calls.find(
      (c) => c.op === "delete" && c.table === connectionDatabases,
    );
    expect(childDelete).toBeDefined();
    expect(deps.registry.invalidate).toHaveBeenCalledWith("tok-1");
  });

  it("blocks the last database: throws LastDatabaseProtected without deleting", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.queueSelect([{ id: "conn-1", mcpToken: "tok-1", region: "fra" }]);
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
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.queueSelect([{ id: "conn-1", mcpToken: "tok-1", region: "fra" }]);
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
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.queueSelect([{ id: "conn-1", mcpToken: "tok-1", region: "fra" }]);
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

    expect(result).toMatchObject({ mcpToken: "tok-1" });
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === connectionDatabases,
    );
    expect(childUpdate).toBeDefined();
    const set = childUpdate?.set as { name: string } | undefined;
    expect(set?.name).toBe("warehouse");
    expect(deps.registry.invalidate).toHaveBeenCalledWith("tok-1");
  });

  it("name collision: throws DatabaseNameTaken without updating or invalidating", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.queueSelect([{ id: "conn-1", mcpToken: "tok-1", region: "fra" }]);
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
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
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

    expect(result).toMatchObject({ mcpToken: "tok-1" });
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
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    handle.queueSelect([{ id: "conn-1", mcpToken: "tok-1", region: "fra" }]);
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
});

describe("getConnectionWithDatabase", () => {
  it("returns parent + named child when both exist", async () => {
    handle.queueSelect([
      { id: "conn-1", customerId: customer.id, region: "fra" },
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
      { id: "conn-1", customerId: customer.id, region: "fra" },
    ]);
    handle.queueSelect([]);
    const { getConnectionWithDatabase } = await import(
      "../src/lib/connections.ts"
    );

    const result = await getConnectionWithDatabase(customer, "conn-1", "ghost");
    expect(result).toBeNull();
  });
});
