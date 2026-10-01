// The coverage sweep is the net under the resolver: a relation, call or
// subquery sitting in a part of the tree the resolver doesn't walk must deny,
// not slip through unchecked.

import { loadCorpus } from "@midplane/corpus";
import type { Node } from "@pgsql/types";
import { parseSync } from "libpg-query";
import { beforeAll, expect, it } from "vitest";
import { CatalogIndex } from "../src/catalog.ts";
import { loadParser } from "../src/index.ts";
import { coverageGap, Resolver } from "../src/resolve.ts";

beforeAll(async () => {
  await loadParser();
});

function resolved(sql: string): { stmt: Node; resolver: Resolver } {
  const catalog = new CatalogIndex(
    loadCorpus()[0]?.input.catalog ?? { relations: [], routines: [] },
  );
  const resolver = new Resolver(catalog, { onRelation() {} });
  const stmt = parseSync(sql).stmts?.[0]?.stmt;
  if (!stmt || !("SelectStmt" in stmt)) throw new Error("expected a SELECT");
  resolver.select(stmt.SelectStmt, { parent: null, cteParent: null });
  return { stmt, resolver };
}

it("finds nothing unvisited in a statement the resolver walked", () => {
  const { stmt, resolver } = resolved(
    "WITH x AS (SELECT id FROM users) SELECT x.id, (SELECT count(*) FROM orders) FROM x",
  );
  expect(coverageGap(stmt, resolver.visited)).toBeNull();
});

it.each([
  [
    "RangeVar",
    { RangeVar: { relname: "secrets", inh: true, relpersistence: "p" } },
  ],
  [
    "FuncCall",
    { FuncCall: { funcname: [{ String: { sval: "pg_read_file" } }] } },
  ],
  ["SubLink", { SubLink: { subLinkType: "EXPR_SUBLINK" } }],
  ["ColumnRef", { ColumnRef: { fields: [{ String: { sval: "ssn" } }] } }],
])("catches a %s the resolver never saw", (kind, node) => {
  const { stmt, resolver } = resolved("SELECT id FROM users");
  // A field no handler reads, standing in for one a future grammar adds.
  (stmt as { SelectStmt: Record<string, unknown> }).SelectStmt.futureClause =
    node;
  expect(coverageGap(stmt, resolver.visited)).toBe(kind);
});

it("catches an inline relation the resolver never saw", () => {
  const { stmt, resolver } = resolved("SELECT id FROM users");
  (stmt as { SelectStmt: Record<string, unknown> }).SelectStmt.futureTarget = {
    relname: "secrets",
    inh: true,
    relpersistence: "p",
  };
  expect(coverageGap(stmt, resolver.visited)).toBe("RangeVar");
});
