// Every statement the core rewrites must survive a round trip through the
// parser unchanged, so what the gateway executes is exactly what was analyzed.
// deparse() enforces this per statement; this pins it across the corpus.

import { loadCorpus } from "@midplane/corpus";
import { parseSync } from "libpg-query";
import { beforeAll, expect, it } from "vitest";
import { evaluate, loadParser, normalizeStatement } from "../src/index.ts";
import { deparse } from "../src/rewrite.ts";

beforeAll(async () => {
  await loadParser();
});

function reparse(sql: string): string {
  const stmt = parseSync(sql).stmts?.[0]?.stmt;
  if (!stmt) throw new Error(`no statement in: ${sql}`);
  return deparse(stmt);
}

it("rewritten statements and previews are deparse fixpoints", () => {
  let checked = 0;
  for (const c of loadCorpus()) {
    const e = evaluate(c.input);
    if (e.verdict === "deny") continue;
    const sqls = [e.plan.statement !== c.input.sql ? e.plan.statement : null];
    if (e.verdict === "hold" && e.preview) sqls.push(e.preview.sql);
    for (const sql of sqls) {
      if (sql === null) continue;
      expect(reparse(sql), c.id).toBe(sql);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(0);
});

it("refuses a tree the deparser can't say faithfully", () => {
  // An explicit `inh: false` is ONLY to Postgres, but the deparser prints ONLY
  // only for an absent field, so this would run against every partition.
  const tree = {
    SelectStmt: {
      targetList: [
        {
          ResTarget: {
            val: { ColumnRef: { fields: [{ String: { sval: "id" } }] } },
          },
        },
      ],
      fromClause: [
        { RangeVar: { relname: "events", inh: false, relpersistence: "p" } },
      ],
      limitOption: "LIMIT_OPTION_DEFAULT" as const,
      op: "SETOP_NONE" as const,
    },
  };
  expect(() => deparse(tree)).toThrow(/could not rewrite it faithfully/);
});

it("keeps AS inside a subquery in an UPDATE's SET", () => {
  const stmt = parseSync(
    "UPDATE t SET name = (SELECT x AS y FROM y AS x LIMIT 1) WHERE id = 1",
  ).stmts?.[0]?.stmt;
  if (!stmt) throw new Error("no statement");
  expect(deparse(stmt)).toContain("SELECT x AS y");
});

it("normalizes a statement to what the parser reads", () => {
  // A lone carriage return ends a `--` comment for the parser but not for
  // many renderers, which would show the rest of the line as comment.
  expect(normalizeStatement("SELECT 1 -- note\rupdate")).toBe(
    "SELECT 1 AS update",
  );
  expect(
    normalizeStatement("DELETE FROM t -- only old rows\r WHERE id = 1"),
  ).toBe("DELETE FROM t WHERE id = 1");
  expect(normalizeStatement("/* hi */ select  1")).toBe("SELECT 1");
  expect(normalizeStatement("SELECT 1; SELECT 2")).toBeNull();
  expect(normalizeStatement("not sql")).toBeNull();
});
