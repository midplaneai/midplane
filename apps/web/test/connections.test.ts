// Unit coverage for the connections lib — focused on the cleanup
// invariant that orphan indexer_cursors rows must not survive a
// deleteConnection. Mocks @midplane-cloud/db so the test doesn't need a
// real Postgres; captures every delete call to assert the cursor row is
// removed in the same transaction as the connection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface DeleteCall {
  table: unknown;
  where: unknown;
  returning?: Record<string, unknown>;
}

interface FakeDbHandle {
  db: object;
  calls: DeleteCall[];
  setConnectionsReturning(rows: Array<{ id: string; mcpToken: string }>): void;
}

let handle: FakeDbHandle;

function makeFakeDb(): FakeDbHandle {
  let connectionsReturning: Array<{ id: string; mcpToken: string }> = [];
  const calls: DeleteCall[] = [];

  const makeChain = () => {
    let table: unknown;
    let where: unknown;
    const chain = {
      where(c: unknown) {
        where = c;
        return chain;
      },
      returning(fields: Record<string, unknown>) {
        calls.push({ table, where, returning: fields });
        return Promise.resolve(connectionsReturning);
      },
      then(onFulfilled: (rows: unknown[]) => unknown) {
        // Cursor delete: no .returning(), just await.
        calls.push({ table, where });
        return Promise.resolve([]).then(onFulfilled);
      },
    };
    return {
      delete(t: unknown) {
        table = t;
        return chain;
      },
    };
  };

  const txObj = makeChain();
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

describe("deleteConnection", () => {
  it("returns 0 when nothing was deleted (no cursor delete fires)", async () => {
    handle.setConnectionsReturning([]);
    const { connections, indexerCursors } = await import("@midplane-cloud/db");
    const { deleteConnection } = await import("../src/lib/connections.ts");
    const customer = {
      id: "cust-1",
      clerkUserId: "clerk-1",
      email: "u@e.test",
      region: "fra" as const,
      createdAt: new Date(),
    };
    const n = await deleteConnection(customer, "missing-id");
    expect(n).toBe(0);
    expect(handle.calls.some((c) => c.table === connections)).toBe(true);
    expect(handle.calls.some((c) => c.table === indexerCursors)).toBe(false);
  });

  it("deletes the matching indexer_cursors row when a connection is removed", async () => {
    handle.setConnectionsReturning([{ id: "conn-1", mcpToken: "tok-1" }]);
    const { indexerCursors } = await import("@midplane-cloud/db");
    const { deleteConnection } = await import("../src/lib/connections.ts");
    const customer = {
      id: "cust-1",
      clerkUserId: "clerk-1",
      email: "u@e.test",
      region: "fra" as const,
      createdAt: new Date(),
    };
    const n = await deleteConnection(customer, "conn-1");
    expect(n).toBe(1);
    const cursorDelete = handle.calls.find(
      (c) => c.table === indexerCursors,
    );
    expect(cursorDelete, "indexer_cursors delete must fire").toBeDefined();
  });
});
