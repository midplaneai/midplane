// isReadOnlySelect — the cloud-side read-only floor for the masked preview.
//
// This is defense-in-depth (the engine's table_access/multi_statement/guardrails
// are the real enforcement), so the bar is: never let an obviously-destructive
// statement reach execution. A leading SELECT is read-only in Postgres; writes
// and data-modifying CTEs (which lead with WITH) must be rejected up front.

import { describe, expect, it } from "vitest";

import {
  isReadOnlySelect,
  stripLeadingComments,
  withRowLimit,
} from "../src/lib/preview-sql.ts";

describe("isReadOnlySelect", () => {
  it("allows a plain SELECT", () => {
    expect(isReadOnlySelect("select email from users limit 10").ok).toBe(true);
  });

  it("allows SELECT regardless of case and leading whitespace", () => {
    expect(isReadOnlySelect("   \n  SeLeCt 1").ok).toBe(true);
  });

  it("allows a SELECT prefixed with comments", () => {
    expect(isReadOnlySelect("-- a note\nselect 1").ok).toBe(true);
    expect(isReadOnlySelect("/* block */ select 1").ok).toBe(true);
  });

  it("rejects an empty statement", () => {
    expect(isReadOnlySelect("   ").ok).toBe(false);
  });

  for (const sql of [
    "delete from users",
    "update users set email = null",
    "insert into users (email) values ('x')",
    "drop table users",
    "truncate users",
    "alter table users add column x int",
    // data-modifying CTE leads with WITH, not SELECT → rejected
    "with d as (delete from users returning *) select * from d",
  ]) {
    it(`rejects a write: ${sql.slice(0, 24)}…`, () => {
      const res = isReadOnlySelect(sql);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/read-only SELECT/i);
    });
  }

  it("is not fooled by a select-looking substring later in the statement", () => {
    // Leads with UPDATE; the word `select` appears in a subquery — still a write.
    expect(isReadOnlySelect("update t set x=(select 1)").ok).toBe(false);
  });

  // SELECT ... INTO is a top-level SelectStmt that CREATES a table — leads with
  // SELECT but writes. Must be rejected (the engine doesn't catch it).
  for (const sql of [
    "select * into leaked_copy from users",
    "SELECT id, email INTO TEMP t FROM users",
    "select * into unlogged x from users where id > 0",
  ]) {
    it(`rejects SELECT INTO: ${sql.slice(0, 28)}…`, () => {
      const res = isReadOnlySelect(sql);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/INTO/i);
    });
  }

  it("is not fooled by the word 'into' inside a string literal or comment", () => {
    // `into` only appears in a string / comment — a real read-only SELECT.
    expect(isReadOnlySelect("select email from users where note = 'sign into app'").ok).toBe(true);
    expect(isReadOnlySelect("select email /* migrate into v2 */ from users").ok).toBe(true);
  });
});

describe("withRowLimit", () => {
  it("appends a top-level LIMIT when none is present", () => {
    expect(withRowLimit("select email from users", 25)).toBe(
      "select email from users\nLIMIT 25",
    );
  });

  it("strips a trailing semicolon before appending", () => {
    expect(withRowLimit("select * from users;", 25)).toBe("select * from users\nLIMIT 25");
  });

  it("appends after an ORDER BY", () => {
    expect(withRowLimit("select * from users order by id", 25)).toBe(
      "select * from users order by id\nLIMIT 25",
    );
  });

  for (const sql of [
    "select * from users limit 10",
    "select * from users LIMIT 10 OFFSET 5",
    "select * from users limit all",
    "select * from users offset 5",
    "select * from users fetch first 10 rows only",
    "select * from users limit 10;",
  ]) {
    it(`leaves an already-bounded statement alone: ${sql.slice(0, 32)}…`, () => {
      const out = withRowLimit(sql, 25);
      expect(out).not.toMatch(/LIMIT 25/);
    });
  }

  it("bounds the OUTER query even when a subquery has its own limit", () => {
    // The inner limit is not trailing (it's inside parens), so the outer query
    // would otherwise be unbounded — append a top-level LIMIT.
    const out = withRowLimit("select * from (select * from t limit 5) x", 25);
    expect(out).toMatch(/\nLIMIT 25$/);
  });
});

describe("stripLeadingComments", () => {
  it("strips stacked leading comments and whitespace", () => {
    expect(stripLeadingComments("-- one\n/* two */\n  select 1")).toBe("select 1");
  });
  it("leaves a bare statement untouched", () => {
    expect(stripLeadingComments("select 1")).toBe("select 1");
  });
});
