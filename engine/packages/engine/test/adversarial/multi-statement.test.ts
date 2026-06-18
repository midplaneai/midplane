// Adversarial corpus — multi_statement (stacked-statement injection).
//
// V1: any query whose AST contains more than one top-level statement is
// denied. Counts AST stmts (`tree.stmts.length`), not raw semicolons —
// so semicolons inside string literals, dollar-quoted bodies, line
// comments, and block comments do NOT inflate the count.
//
// Real-world precedent: Datadog Security Labs's stacked-statement SQLi
// disclosure against the deprecated Anthropic Postgres MCP
// (`SELECT 1; DROP TABLE users`).

import { describe, expect, test } from "bun:test";
import { makeEngine, baseCtx } from "../_helpers.ts";
import { PolicyRule } from "../../src/audit/types.ts";
import { expectDeny, expectAllow, expectDecidedDeny } from "./_helpers.ts";

const MULTI = PolicyRule.MULTI_STATEMENT;
const PARSE = PolicyRule.PARSE_ERROR;
const WRITES = PolicyRule.WRITES_REQUIRE_APPROVAL;

describe("adversarial/multi-statement: canonical stacked injection", () => {
  test("SELECT 1; DROP TABLE users; → deny on multi_statement", async () => {
    const { engine, audit } = makeEngine();
    await expectDeny(engine, baseCtx, "SELECT 1; DROP TABLE users;", MULTI);
    expectDecidedDeny(audit, MULTI);
  });

  test("three statements → deny on multi_statement", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "SELECT 1; SELECT 2; SELECT 3", MULTI);
  });

  test("write stacked on read → deny on multi_statement (rule order)", async () => {
    // Rule order in evaluate(): parse_error → multi_statement → writes …
    // Multi fires first; writes never gets to fire. The point of this test
    // is to lock in that ordering decision.
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "UPDATE x SET n=1; SELECT 1", MULTI);
  });
});

describe("adversarial/multi-statement: comment-as-injection (must NOT fool)", () => {
  test("line comment hides DROP → 1 stmt, allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT 1; -- ; DROP TABLE x;");
  });

  test("block comment hides DROP → 1 stmt, allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "/* ; SELECT 99; */ SELECT 1");
  });

  test("line comment with semicolons before SELECT → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "-- ; ; ;\nSELECT 1");
  });

  test("nested-looking block comment with semicolons → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "/* DROP TABLE x; */ SELECT 1");
  });

  test("comment AFTER stmt + actual stacked stmt → still deny on multi", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "SELECT 1; /* benign */ SELECT 2",
      MULTI,
    );
  });
});

describe("adversarial/multi-statement: semicolons in string literals", () => {
  test("single-quoted string with embedded ; → 1 stmt, allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT 'a;b'");
  });

  test("string literal with stacked-looking content → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT 'a; DROP TABLE x; --b'");
  });

  test("escaped quote with embedded ; → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT E'a\\'; b'");
  });

  test("dollar-quoted string with embedded ; → 1 stmt, allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT $$multi; line; here$$");
  });

  test("dollar-quoted with $tag$ delimiter and ; → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT $tag$x; y; z$tag$");
  });
});

describe("adversarial/multi-statement: empty/trailing semicolons", () => {
  test("trailing ; on single stmt → 1 stmt, allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT 1;");
  });

  test("multiple trailing semicolons collapse to one stmt → allow", async () => {
    // libpg-query strips empty trailing statements before counting, so
    // SELECT 1;;; parses to stmts.length=1. Pinned here so a parser
    // upgrade that starts counting trailing empties as separate stmts
    // (silently flipping this to multi_statement) is caught in CI.
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT 1;;;");
  });

  test("leading ; before single stmt → 1 stmt, allow", async () => {
    // Same reasoning, leading-empty edge. Pinned to allow so a parser
    // regression that counts the leading empty as a separate stmt
    // surfaces immediately.
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, ";SELECT 1");
  });

  test("only semicolons → parse_error (no real statements)", async () => {
    // ";" and ";;;" parse to stmts=[], which the parser surfaces as
    // parse_error per the no-statements tightening in this PR.
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, ";", PARSE);
    await expectDeny(engine, baseCtx, ";;;", PARSE);
  });
});

describe("adversarial/multi-statement: real stacked DDL", () => {
  test("stacked CREATE + DROP → deny on multi_statement", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "CREATE TABLE x (id int); DROP TABLE x;",
      MULTI,
    );
  });

  test("stacked SELECT + GRANT → deny on multi_statement", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "SELECT 1; GRANT SELECT ON users TO some_role",
      MULTI,
    );
  });

  test("stacked SELECT + COPY → deny on multi_statement", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "SELECT 1; COPY users TO '/tmp/leak'",
      MULTI,
    );
  });

  test("stacked transaction control + write → deny on multi_statement", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "BEGIN; UPDATE users SET name='b' WHERE id=1; COMMIT",
      MULTI,
    );
  });
});

