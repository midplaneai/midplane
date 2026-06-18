// Structural guard: the policy layer must stay dialect-blind.
//
// After the normalized-IR cut-over (PR1), the rules consume only the IR — no
// rule may name a libpg_query AST node. All such names live in the dialect
// adapter (dialects/postgres/normalize.ts). This test fails if a libpg node
// name (or the relocated WRITE_STATEMENT_KINDS set) reappears anywhere under
// src/policy/, so the decoupling can't silently regress.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const POLICY_DIR = join(import.meta.dir, "..", "..", "src", "policy");

// libpg_query tagged-union node names + AST field names + the relocated
// write-kind set. None of these belong in the dialect-agnostic policy layer.
const FORBIDDEN = [
  "RangeVar",
  "SelectStmt",
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "MergeStmt",
  "A_Expr",
  "A_Const",
  "BoolExpr",
  "ColumnRef",
  "CommonTableExpr",
  "valuesLists",
  "ONCONFLICT",
  "WRITE_STATEMENT_KINDS",
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("policy layer stays dialect-blind (no libpg AST coupling)", () => {
  for (const file of tsFiles(POLICY_DIR)) {
    test(`${file.slice(file.indexOf("src/policy"))} names no libpg AST node`, () => {
      const text = readFileSync(file, "utf8");
      const hits = FORBIDDEN.filter((token) => text.includes(token));
      expect(hits).toEqual([]);
    });
  }
});
