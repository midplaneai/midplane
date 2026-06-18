// resolveScope — maps a credential's mcp_scope_grants rows to the engine
// X-Midplane-Scope shape (db NAME → access), intersected with the connection's
// databases. scopeHeaderValue serializes it (or null when empty = unscoped).
//
// Like resolve.test.ts, a tiny fake Drizzle Db: resolveScope issues exactly one
// select().from().where(), so `where()` is the terminal that resolves the
// staged rows. The fake ignores the WHERE (the test stages the rows the query
// would return); the NAME mapping + intersection logic is what's under test.

import { describe, expect, it } from "vitest";

import type { ConnectionDatabase } from "@midplane-cloud/db";

import { resolveScope, scopeHeaderValue } from "../src/scope.ts";
import type { Db } from "../src/resolve.ts";

function fakeDb(rows: unknown[]): Db {
  const chain = {
    from() {
      return chain;
    },
    where() {
      return Promise.resolve(rows);
    },
  };
  return { select: () => chain } as unknown as Db;
}

// Minimal connection_databases rows — resolveScope reads only id + name.
const cdb = (id: string, name: string): ConnectionDatabase =>
  ({ id, name }) as unknown as ConnectionDatabase;

const DATABASES = [cdb("cdb-1", "main"), cdb("cdb-2", "analytics")];

describe("resolveScope", () => {
  it("maps OAuth grant rows (connection_database_id) to db name → access", async () => {
    const db = fakeDb([
      { connectionDatabaseId: "cdb-1", access: "read" },
      { connectionDatabaseId: "cdb-2", access: "write" },
    ]);
    const scope = await resolveScope(
      db,
      { kind: "oauth", clientId: "client-x", userId: "user-y" },
      DATABASES,
    );
    expect(scope.size).toBe(2);
    expect(scope.get("main")).toBe("read");
    expect(scope.get("analytics")).toBe("write");
  });

  it("maps headless-token grant rows the same way", async () => {
    const db = fakeDb([{ connectionDatabaseId: "cdb-1", access: "read" }]);
    const scope = await resolveScope(
      db,
      { kind: "token", mcpTokenId: "tok-1" },
      DATABASES,
    );
    expect(scope.size).toBe(1);
    expect(scope.get("main")).toBe("read");
  });

  it("returns an empty map when the credential has no grants", async () => {
    const scope = await resolveScope(
      fakeDb([]),
      { kind: "oauth", clientId: "c", userId: "u" },
      DATABASES,
    );
    expect(scope.size).toBe(0);
  });

  it("ignores grant rows for a DB that isn't part of this connection", async () => {
    // A row for cdb-99 (not in DATABASES) is dropped — defends against a stale
    // grant whose DB was removed, and the name mapping can't resolve it.
    const db = fakeDb([
      { connectionDatabaseId: "cdb-1", access: "write" },
      { connectionDatabaseId: "cdb-99", access: "write" },
    ]);
    const scope = await resolveScope(
      db,
      { kind: "token", mcpTokenId: "tok-1" },
      DATABASES,
    );
    expect(scope.size).toBe(1);
    expect(scope.get("main")).toBe("write");
  });

  it("short-circuits (no query) when the connection has no databases", async () => {
    // fakeDb([]) would resolve [], but the empty-databases guard returns first.
    const scope = await resolveScope(
      fakeDb([{ connectionDatabaseId: "cdb-1", access: "read" }]),
      { kind: "oauth", clientId: "c", userId: "u" },
      [],
    );
    expect(scope.size).toBe(0);
  });
});

describe("scopeHeaderValue", () => {
  it("serializes a non-empty scope to the engine's JSON shape", () => {
    const scope = new Map([
      ["main", "read"],
      ["analytics", "write"],
    ] as const);
    const value = scopeHeaderValue(scope);
    expect(value).not.toBeNull();
    expect(JSON.parse(value!)).toEqual({ main: "read", analytics: "write" });
  });

  it("returns null for an empty scope (= unscoped, full access)", () => {
    expect(scopeHeaderValue(new Map())).toBeNull();
  });
});
