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
// All mocks are shape-only — no real Postgres or KMS contact, so the suite
// runs in vitest's plain node env.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface DbCall {
  op: "delete" | "update";
  table: unknown;
  set?: unknown;
  where: unknown;
  returning?: Record<string, unknown>;
}

interface FakeDbHandle {
  db: object;
  calls: DbCall[];
  setConnectionsReturning(
    rows: Array<{ id: string; mcpToken: string; region?: string }>,
  ): void;
}

let handle: FakeDbHandle;

function makeFakeDb(): FakeDbHandle {
  let connectionsReturning: Array<{
    id: string;
    mcpToken: string;
    region?: string;
  }> = [];
  const calls: DbCall[] = [];

  const makeRoot = () => {
    const startChain = (op: "delete" | "update", table: unknown) => {
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
          return Promise.resolve(connectionsReturning);
        },
        then(onFulfilled: (rows: unknown[]) => unknown) {
          // Used by the cursor delete which doesn't call .returning().
          calls.push({ op, table, set: setValue, where: whereValue });
          return Promise.resolve([]).then(onFulfilled);
        },
      };
      return chain;
    };
    return {
      delete(t: unknown) {
        return startChain("delete", t);
      },
      update(t: unknown) {
        return startChain("update", t);
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
    setConnectionsReturning(rows) {
      connectionsReturning = rows;
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
  it("happy path: stamps ciphertext + kms_key_id + rotated_at AND invalidates both caches", async () => {
    handle.setConnectionsReturning([
      { id: "conn-1", mcpToken: "tok-1", region: "fra" },
    ]);
    const { connections } = await import("@midplane-cloud/db");
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

    const update = handle.calls.find(
      (c) => c.op === "update" && c.table === connections,
    );
    expect(update, "rotation must issue UPDATE on connections").toBeDefined();
    const set = update?.set as
      | { encryptedDsn: Buffer; kmsKeyId: string; rotatedAt: Date }
      | undefined;
    expect(set?.encryptedDsn).toEqual(
      Buffer.from("ct:postgres://u:p@host:5432/db"),
    );
    expect(set?.kmsKeyId).toBe(`env:fra:${"postgres://u:p@host:5432/db".length}`);
    expect(set?.rotatedAt).toBeInstanceOf(Date);

    expect(caches.cache.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.cache.invalidate).toHaveBeenCalledWith("conn-1", "fra");
    expect(caches.registry.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledWith("tok-1");
  });

  it("404 path: returns null and skips both invalidations when ownership mismatches", async () => {
    handle.setConnectionsReturning([]);
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
    handle.setConnectionsReturning([
      { id: "conn-1", mcpToken: "tok-1", region: "fra" },
    ]);
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
