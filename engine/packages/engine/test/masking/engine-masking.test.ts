// Engine.handle integration with column masking.
//
// Uses the real parser (so tablesTouched is produced exactly as enforcement
// computes it), a mock executor that returns RowDescription `fields`, and a
// fake catalog resolver. Proves: masked values are transformed in the returned
// result + audited; a view output rejects (rows withheld) + audits the reject;
// no masking config is a passthrough; a stale catalog triggers one refresh.

import { describe, expect, test } from "bun:test";
import { Engine } from "../../src/engine.ts";
import {
  MemoryAuditWriter,
  MockExecutor,
  StubCredentialStore,
  baseCtx,
} from "../_helpers.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { tableAccess } from "../../src/policy/rules/table-access.ts";
import { tenantScope } from "../../src/policy/rules/tenant-scope.ts";
import { dangerousStatement } from "../../src/policy/rules/dangerous-statement.ts";
import {
  type Catalog,
  type ColumnMasks,
  type RelInfo,
} from "../../src/masking/mask-result-set.ts";
import type { CatalogResolver } from "../../src/masking/catalog.ts";
import type { MaskingConfig } from "../../src/engine.ts";
import type { ExecutionResult } from "../../src/executor.ts";

const USERS = 100, USERS_V = 300;
const rel = (relname: string, relkind: string, top: number, cols: Record<number, string>): RelInfo => ({
  schema: "public",
  relname,
  relkind,
  topParentOid: top,
  columns: new Map(Object.entries(cols).map(([k, v]) => [Number(k), v])),
});
const CATALOG: Catalog = new Map([
  [USERS, rel("users", "r", USERS, { 1: "id", 2: "email", 3: "ssn" })],
  [USERS_V, rel("users_v", "v", USERS_V, { 1: "id", 2: "email" })],
]);
const MASKS: ColumnMasks = new Map([["public.users", new Map([["email", "full-redact"]])]]);

class FakeResolver implements CatalogResolver {
  invalidations = 0;
  constructor(private full: Catalog, private staleUntilInvalidate = false) {}
  async resolve(): Promise<Catalog> {
    return this.staleUntilInvalidate && this.invalidations === 0 ? new Map() : this.full;
  }
  invalidate() { this.invalidations++; }
}

function makeMaskingEngine(masking?: MaskingConfig) {
  const audit = new MemoryAuditWriter();
  const executor = new MockExecutor();
  let counter = 0;
  const engine = new Engine({
    policy: { rules: [parseError(), multiStatement(), tableAccess(), tenantScope(), dangerousStatement()] },
    audit,
    credentials: new StubCredentialStore(),
    executor,
    masking,
    now: () => 1_700_000_000_000,
    idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
  });
  return { engine, audit, executor };
}

const result = (rows: unknown[], fields: ExecutionResult["fields"]): ExecutionResult => ({
  rows,
  rowCount: rows.length,
  fields,
});

describe("Engine.handle + masking", () => {
  test("masks the declared column in the returned result and audits columns_masked", async () => {
    const { engine, audit, executor } = makeMaskingEngine({
      columnMasks: MASKS,
      salt: "s",
      resolver: new FakeResolver(CATALOG),
    });
    executor.result = result(
      [{ email: "ada@acme.io" }],
      [{ name: "email", tableOid: USERS, columnAttnum: 2, dataTypeOid: 25 }],
    );

    const d = await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx });

    expect(d.allowed).toBe(true);
    if (d.allowed) expect((d.result.rows[0] as any).email).toBe("***");
    const exec = audit.byType("EXECUTED")[0]!;
    expect((exec.payload as any).columns_masked).toEqual(["public.users.email"]);
    expect((exec.payload as any).masking_rejected).toBeUndefined();
  });

  test("rejects a view output: rows withheld, structured denial, audit marks masking_rejected", async () => {
    const { engine, audit, executor } = makeMaskingEngine({
      columnMasks: MASKS,
      salt: "s",
      resolver: new FakeResolver(CATALOG),
    });
    executor.result = result(
      [{ email: "ada@acme.io" }],
      [{ name: "email", tableOid: USERS_V, columnAttnum: 2, dataTypeOid: 25 }],
    );

    const d = await engine.handle({ sql: "SELECT email FROM users_v", ctx: baseCtx });

    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("column_masking");
      expect(d.message).toContain("view");
    }
    // The query DID execute (the executor ran) and EXECUTED is still audited.
    expect(executor.calls.length).toBe(1);
    const exec = audit.byType("EXECUTED")[0]!;
    expect((exec.payload as any).masking_rejected).toBe(true);
    expect((exec.payload as any).masking_reason).toContain("view");
  });

  test("no masking config is a transparent passthrough (plaintext returned)", async () => {
    const { engine, executor } = makeMaskingEngine(undefined);
    executor.result = result(
      [{ email: "ada@acme.io" }],
      [{ name: "email", tableOid: USERS, columnAttnum: 2, dataTypeOid: 25 }],
    );
    const d = await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx });
    expect(d.allowed).toBe(true);
    if (d.allowed) expect((d.result.rows[0] as any).email).toBe("ada@acme.io");
  });

  test("a stale catalog triggers exactly one refresh, then masks", async () => {
    const resolver = new FakeResolver(CATALOG, /* staleUntilInvalidate */ true);
    const { engine, executor } = makeMaskingEngine({ columnMasks: MASKS, salt: "s", resolver });
    executor.result = result(
      [{ email: "ada@acme.io" }],
      [{ name: "email", tableOid: USERS, columnAttnum: 2, dataTypeOid: 25 }],
    );
    const d = await engine.handle({ sql: "SELECT email FROM users", ctx: baseCtx });
    expect(resolver.invalidations).toBe(1); // refreshed once
    expect(d.allowed).toBe(true);
    if (d.allowed) expect((d.result.rows[0] as any).email).toBe("***");
  });
});
