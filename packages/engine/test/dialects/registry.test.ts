// Dialect registry + seam tests.
//
// Pins the contracts the rest of the codebase (Engine, mcp-server factory)
// relies on. Three slices:
//   1. getDialect() — lookup behavior, unknown-name failure mode.
//   2. postgresDialect — the wrapper matches the bare parse() export
//      byte-for-byte so the public API back-compat promise holds.
//   3. Engine default — `new Engine({...})` without an explicit `dialect:`
//      falls through to postgresDialect (pre-0.6.0 embedder contract).

import { describe, expect, test } from "bun:test";
import {
  DIALECTS,
  getDialect,
  postgresDialect,
  mysqlDialect,
} from "../../src/dialects/index.ts";
import { parse } from "../../src/dialects/postgres/parse.ts";
import { Engine } from "../../src/engine.ts";
import {
  MemoryAuditWriter,
  MockExecutor,
  StubCredentialStore,
  baseCtx,
} from "../_helpers.ts";

describe("dialects/registry: getDialect()", () => {
  test("'postgres' returns the postgres dialect singleton", () => {
    expect(getDialect("postgres")).toBe(postgresDialect);
  });

  test("'mysql' returns the mysql dialect singleton (0.7.0)", () => {
    expect(getDialect("mysql")).toBe(mysqlDialect);
  });

  test("DIALECTS map exposes 'postgres' and 'mysql'", () => {
    expect(Object.keys(DIALECTS)).toContain("postgres");
    expect(Object.keys(DIALECTS)).toContain("mysql");
    expect(DIALECTS.postgres).toBe(postgresDialect);
    expect(DIALECTS.mysql).toBe(mysqlDialect);
  });

  test("unknown dialect name throws with a helpful message", () => {
    // Cast through unknown to bypass the TS type-level guard — the runtime
    // check is what protects against a future config-loader bug that lets
    // an unvalidated string reach the registry. Uses dialect names not yet
    // implemented (sqlite is Phase 1.5).
    expect(() => getDialect("sqlite" as unknown as "postgres")).toThrow(
      /Unknown dialect/,
    );
    expect(() => getDialect("" as unknown as "postgres")).toThrow(
      /Unknown dialect/,
    );
  });
});

describe("dialects/registry: postgresDialect contract", () => {
  test("name field is 'postgres'", () => {
    expect(postgresDialect.name).toBe("postgres");
  });

  test("parse() delegates to the bare parse() export byte-for-byte", async () => {
    // The public API of @midplane/engine re-exports `parse` from the same
    // source as `postgresDialect.parse`. Confirm they produce identical
    // ParseResult objects so an embedder reading either gets the same AST.
    const sql = "SELECT id FROM users WHERE org_id = 42";
    const a = await postgresDialect.parse(sql);
    const b = await parse(sql);
    expect(a).toEqual(b);
  });

  test("parse() surfaces parse-failure result for bad SQL (not a throw)", async () => {
    // The Dialect contract: bad SQL is `{ ok: false, error }`, not a thrown
    // exception. Engine.handle() depends on this — it converts thrown
    // errors to a synthetic parse-failure, but the dialect itself must
    // not throw on SqlError.
    const result = await postgresDialect.parse("SELEKT 1");
    expect(result.ok).toBe(false);
  });

  test("warmup() is callable and idempotent", async () => {
    // The engine calls dialect.warmup() implicitly via parse(); calling it
    // directly more than once must not throw (the wrapper memoizes).
    await postgresDialect.warmup();
    await postgresDialect.warmup();
  });
});

describe("dialects/registry: Engine default dialect", () => {
  // Pre-0.6.0 embedders constructed `new Engine({...})` with no `dialect:`
  // arg; they must keep parsing as Postgres unchanged.
  test("Engine without `dialect:` defaults to postgres parsing", async () => {
    const audit = new MemoryAuditWriter();
    const executor = new MockExecutor();
    const credentials = new StubCredentialStore();

    const engine = new Engine({
      policy: { rules: [] }, // no rules → every parse outcome ALLOWs
      audit,
      credentials,
      executor,
      // explicitly omit `dialect:` — the test
    });

    // A query with libpg_query-specific syntax (dollar-quoted body) must
    // parse cleanly under the PG default. If the default ever drifted to a
    // weaker parser, the AST would either reject this or produce a
    // different stmt count.
    const sql = "SELECT $tag$hello;world$tag$";
    const decision = await engine.handle({ sql, ctx: baseCtx });
    expect(decision.allowed).toBe(true);

    // The DECIDED audit row carries statement_type derived from the
    // libpg_query AST — "SELECT" comes from the `SelectStmt` node name.
    const decided = audit.byType("DECIDED")[0]!;
    expect((decided.payload as { statement_type: string }).statement_type).toBe(
      "SELECT",
    );
  });

  test("Engine with explicit `dialect: postgresDialect` matches default behavior", async () => {
    // Round-trip pin: passing the dialect explicitly must be equivalent to
    // omitting it. Protects against the default-resolution code drifting
    // away from the explicit-pass code path.
    const audit = new MemoryAuditWriter();
    const engine = new Engine({
      policy: { rules: [] },
      audit,
      credentials: new StubCredentialStore(),
      executor: new MockExecutor(),
      dialect: postgresDialect,
    });

    const decision = await engine.handle({
      sql: "SELECT 1",
      ctx: baseCtx,
    });
    expect(decision.allowed).toBe(true);
  });
});
