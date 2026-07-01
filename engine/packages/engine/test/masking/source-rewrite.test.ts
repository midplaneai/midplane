// T0 source-rewrite coordinator + by-name catalog — unit tests (no live DB).
//
// Proves the transaction-scoped contract without Postgres: the salt is set +
// verified fail-closed, the coordinator orchestrates resolve→rewrite→exec on one
// TxClient, falls back (null) when the executor has no withTransaction, and
// buildCatalogByName assembles the ordered column list / parent / relkind a
// rewriter needs. The live-PG equivalence is the Phase-1 harness; this is the
// pure-logic floor.

import { describe, expect, test } from "bun:test";
import {
  runSourceRewrite,
  setMaskSalt,
  MaskSaltError,
  type SourceRewriter,
} from "../../src/masking/source-rewrite.ts";
import { buildCatalogByName, type RelationRef } from "../../src/masking/catalog.ts";
import type { ExecuteContext, ExecutionResult, Executor, TxClient } from "../../src/executor.ts";
import type { ColumnMasks } from "../../src/masking/mask-result-set.ts";

const ctx: ExecuteContext = { tenant_id: "t1", agent_name: null, agent_version: null };
const masks: ColumnMasks = new Map([["public.customers", new Map([["credit_card", "full-redact"]])]]);

// A fake TxClient that records every query and answers from a dispatch table.
function fakeTx(answer: (sql: string, params: unknown[]) => Record<string, unknown>[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const execed: string[] = [];
  const tx: TxClient = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return answer(sql, params);
    },
    exec: async (sql): Promise<ExecutionResult> => {
      execed.push(sql);
      return { rows: [{ ok: 1 }], rowCount: 1, fields: [] };
    },
  };
  return { tx, calls, execed };
}

describe("setMaskSalt", () => {
  test("sets the salt transaction-locally via set_config and verifies it stuck", async () => {
    const { tx, calls } = fakeTx((sql, params) =>
      sql.includes("set_config") ? [{ v: params[1] }] : [],
    );
    await setMaskSalt(tx, "S3CR3T");
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("set_config");
    expect(calls[0].params).toEqual(["midplane.mask_salt", "S3CR3T"]);
  });

  test("rejects an empty salt without touching the DB (fail closed)", async () => {
    const { tx, calls } = fakeTx(() => []);
    await expect(setMaskSalt(tx, "")).rejects.toBeInstanceOf(MaskSaltError);
    expect(calls).toHaveLength(0);
  });

  test("rejects when the salt did not apply (e.g. pooled-GUC reverted to '')", async () => {
    // set_config returns '' instead of the value → the spike's silent-unsalted leak.
    const { tx } = fakeTx(() => [{ v: "" }]);
    await expect(setMaskSalt(tx, "S3CR3T")).rejects.toBeInstanceOf(MaskSaltError);
  });
});

describe("runSourceRewrite", () => {
  const okRewriter: SourceRewriter = {
    collectRefs: () => [{ schema: null, relname: "customers" }],
    rewrite: (sql) => ({ ok: true, sql: `/*rw*/ ${sql}`, maskedColumns: [] }),
    checkShape: () => ({ ok: true, allowlistedFns: [], allowlistedOps: [] }),
    shadowScan: async () => ({ ok: true }),
  };
  // Executor whose withTransaction runs fn against a fake tx and reports salt OK.
  function txExecutor() {
    const { tx, execed } = fakeTx((sql, params) =>
      sql.includes("set_config")
        ? [{ v: params[1] }]
        : sql.includes("pg_class")
          ? [{ oid: 1, relname: "customers", relkind: "r", schema: "public" }]
          : sql.includes("pg_inherits")
            ? []
            : sql.includes("pg_attribute")
              ? [{ oid: 1, attname: "credit_card", typcategory: "S" }]
              : [],
    );
    const executor: Executor = {
      execute: async () => ({ rows: [], rowCount: 0 }),
      withTransaction: async (_c, fn) => fn(tx),
    };
    return { executor, execed };
  }

  test("happy path: sets salt, resolves, rewrites, executes rewritten SQL on the tx", async () => {
    const { executor, execed } = txExecutor();
    const out = await runSourceRewrite("SELECT credit_card FROM customers", ctx, {
      executor,
      rewriter: okRewriter,
      columnMasks: masks,
      salt: "S",
      shadowUsed: { functions: [], operators: [] },
    });
    expect(out).toEqual({ ok: true, result: { rows: [{ ok: 1 }], rowCount: 1, fields: [] }, maskedColumns: [] });
    expect(execed).toEqual(["/*rw*/ SELECT credit_card FROM customers"]); // rewritten, not original
  });

  test("rewriter reject → fail closed, never executes", async () => {
    const { executor, execed } = txExecutor();
    const rejecter: SourceRewriter = {
      collectRefs: () => [{ schema: null, relname: "customers" }],
      rewrite: () => ({ ok: false, reason: "references a view" }),
      checkShape: () => ({ ok: true, allowlistedFns: [], allowlistedOps: [] }),
      shadowScan: async () => ({ ok: true }),
    };
    const out = await runSourceRewrite("SELECT * FROM v", ctx, {
      executor,
      rewriter: rejecter,
      columnMasks: masks,
      salt: "S",
      shadowUsed: { functions: [], operators: [] },
    });
    // The coordinator stamps the reject stage (A2) so the audit/metrics can tell a
    // rewrite-emission reject apart from a covert-channel gate reject.
    expect(out).toEqual({ ok: false, reason: "references a view", stage: "rewrite" });
    expect(execed).toHaveLength(0);
  });

  test("salt that won't apply → reject, no execution", async () => {
    const { tx, execed } = fakeTx(() => [{ v: "" }]); // set_config returns '' (unsalted leak)
    const executor: Executor = {
      execute: async () => ({ rows: [], rowCount: 0 }),
      withTransaction: async (_c, fn) => fn(tx),
    };
    const out = await runSourceRewrite("SELECT credit_card FROM customers", ctx, {
      executor,
      rewriter: okRewriter,
      columnMasks: masks,
      salt: "S",
      shadowUsed: { functions: [], operators: [] },
    });
    expect(out?.ok).toBe(false);
    expect(execed).toHaveLength(0);
  });

  test("executor without withTransaction → null (caller falls back to post-exec masker)", async () => {
    const executor: Executor = { execute: async () => ({ rows: [], rowCount: 0 }) };
    const out = await runSourceRewrite("SELECT 1", ctx, {
      executor,
      rewriter: okRewriter,
      columnMasks: masks,
      salt: "S",
      shadowUsed: { functions: [], operators: [] },
    });
    expect(out).toBeNull();
  });
});

describe("buildCatalogByName", () => {
  // Canned pg_class / pg_inherits / pg_attribute responses for a `customers` table
  // (oid 1) that is a partition child of `customers_all` (oid 2).
  const queryFn = async (sql: string): Promise<Record<string, unknown>[]> => {
    if (sql.includes("(n.nspname, c.relname) IN"))
      return [{ oid: 1, relname: "customers", relkind: "r", schema: "public" }];
    if (sql.includes("FROM pg_inherits")) return [{ child: 1, parent: 2 }];
    if (sql.includes("c.oid = ANY($1::oid[])"))
      return [
        { oid: 1, relname: "customers", schema: "public" },
        { oid: 2, relname: "customers_all", schema: "public" },
      ];
    if (sql.includes("pg_attribute"))
      return [
        { oid: 1, attname: "id", typcategory: "N" },
        { oid: 1, attname: "name", typcategory: "S" },
        { oid: 1, attname: "credit_card", typcategory: "S" },
      ];
    return [];
  };

  test("assembles ordered columns, relkind, parentKey, and type categories", async () => {
    const refs: RelationRef[] = [{ schema: null, relname: "customers" }];
    const cat = await buildCatalogByName(queryFn, refs);
    const rel = cat.get("public.customers");
    expect(rel).toBeDefined();
    expect(rel!.relkind).toBe("r");
    expect(rel!.columns).toEqual(["id", "name", "credit_card"]); // attnum order preserved
    expect(rel!.parentKey).toBe("public.customers_all"); // resolves to inheritance parent
    expect(rel!.columnTypes.get("credit_card")).toBe("S");
  });

  test("an unresolved relation is simply absent (rewriter fails closed on the gap)", async () => {
    const cat = await buildCatalogByName(async () => [], [{ schema: null, relname: "ghost" }]);
    expect(cat.get("public.ghost")).toBeUndefined();
  });

  test("no refs → empty catalog, no DB round-trips", async () => {
    let calls = 0;
    const cat = await buildCatalogByName(async () => ((calls++), []), []);
    expect(cat.size).toBe(0);
    expect(calls).toBe(0);
  });
});
