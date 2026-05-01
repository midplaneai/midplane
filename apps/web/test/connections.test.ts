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
  op: "delete" | "update" | "select";
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
}

let handle: FakeDbHandle;

function makeFakeDb(): FakeDbHandle {
  let parentSelect: Array<{
    id: string;
    mcpToken: string;
    region?: string;
  }> = [];
  let childUpdate: Array<{ id: string }> = [];
  let deletedConnections: Array<{ id: string; mcpToken: string }> = [];
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
          // Pick the right return based on which table is being mutated.
          // The parent UPDATE/DELETE returns deletedConnections (only used
          // by deleteConnection); a child UPDATE returns childUpdate.
          if (op === "delete") return Promise.resolve(deletedConnections);
          // Heuristic: child update sets connection_databases columns
          // (encryptedDsn / kmsKeyId / rotatedAt or tableAccess); parent
          // updates only set `name`. Distinguish on the set shape.
          const set = setValue as Record<string, unknown> | undefined;
          if (set && ("encryptedDsn" in set || "tableAccess" in set || "tenantScopeMappings" in set)) {
            return Promise.resolve(childUpdate);
          }
          // Bare update with a `name` field — used by renameConnection. We
          // don't exercise that path in this suite, but return [] to keep
          // the chain honest.
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
          return Promise.resolve(parentSelect);
        },
        orderBy() {
          return chain;
        },
        then(onFulfilled: (rows: unknown[]) => unknown) {
          calls.push({ op: "select", table, where: whereValue });
          return Promise.resolve(parentSelect).then(onFulfilled);
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
    setConnectionsReturning(rows) {
      deletedConnections = rows;
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
    expect(result).toEqual({ mcpToken: "tok-1" });
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
