// isReadOnlySelect — the cloud-side read-only floor for the masked preview.
//
// This is defense-in-depth (the engine's table_access/multi_statement/guardrails
// are the real enforcement), so the bar is: never let an obviously-destructive
// statement reach execution. A leading SELECT is read-only in Postgres; writes
// and data-modifying CTEs (which lead with WITH) must be rejected up front.

import { describe, expect, it } from "vitest";

import { isReadOnlySelect, stripLeadingComments } from "../src/lib/preview-sql.ts";

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
});

describe("stripLeadingComments", () => {
  it("strips stacked leading comments and whitespace", () => {
    expect(stripLeadingComments("-- one\n/* two */\n  select 1")).toBe("select 1");
  });
  it("leaves a bare statement untouched", () => {
    expect(stripLeadingComments("select 1")).toBe("select 1");
  });
});
