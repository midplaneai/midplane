// render.ts — pure unit tests for the shared terminal renderer.

import { describe, expect, test } from "bun:test";
import {
  fmtTs,
  oneLine,
  palette,
  prettyMode,
  renderEventLine,
  renderRowsTable,
  type AuditRowView,
} from "../src/render.ts";

const plain = palette(false);

function row(overrides: Partial<AuditRowView>): AuditRowView {
  return {
    id: "01TEST",
    query_id: "Q1",
    tenant_id: "__self_host__",
    database: "__default__",
    agent_name: null,
    agent_version: null,
    agent_intent: null,
    mcp_token_id: null,
    ts: 1_700_000_000_000,
    event_type: "ATTEMPTED",
    payload: {},
    ...overrides,
  };
}

describe("prettyMode", () => {
  test("--json wins over --pretty", () => {
    expect(prettyMode({ json: "true", pretty: "true" })).toBe(false);
  });

  test("--pretty forces human output on a non-TTY", () => {
    expect(prettyMode({ pretty: "true" }, { isTTY: undefined } as NodeJS.WriteStream)).toBe(true);
  });

  test("defaults to the stream's TTY-ness", () => {
    expect(prettyMode({}, { isTTY: true } as NodeJS.WriteStream)).toBe(true);
    expect(prettyMode({}, { isTTY: undefined } as NodeJS.WriteStream)).toBe(false);
  });
});

describe("palette", () => {
  test("disabled palette is the identity", () => {
    expect(plain.red("x")).toBe("x");
    expect(plain.dim("x")).toBe("x");
  });

  test("enabled palette wraps in ANSI codes", () => {
    const p = palette(true);
    expect(p.red("x")).toBe("\x1b[31mx\x1b[39m");
    expect(p.bold("x")).toBe("\x1b[1mx\x1b[22m");
  });
});

describe("oneLine", () => {
  test("collapses internal whitespace and newlines", () => {
    expect(oneLine("SELECT *\n  FROM users\twhere id = 1")).toBe(
      "SELECT * FROM users where id = 1",
    );
  });

  test("truncates long input with an ellipsis at the cap", () => {
    const out = oneLine("x".repeat(500), 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });

  // sql_raw is attacker-controlled; ESC/CSI/OSC sequences must never reach
  // the operator's terminal via the pretty renderers.
  test("strips terminal control bytes (ANSI/OSC injection defense)", () => {
    const hostile = "SELECT 1 \x1b]0;pwned\x07 -- \x1b[31mred\x9b2J\x00";
    const out = oneLine(hostile);
    expect(out).not.toContain("\x1b");
    expect(out).not.toContain("\x07");
    expect(out).not.toContain("\x9b");
    expect(out).not.toContain("\x00");
    expect(out).toContain("SELECT 1");
    expect(out).toContain("0;pwned"); // text survives, escapes don't
  });
});

describe("fmtTs", () => {
  test("ISO UTC without milliseconds", () => {
    expect(fmtTs(Date.UTC(2026, 5, 11, 9, 15, 3, 123))).toBe("2026-06-11T09:15:03Z");
  });
});

describe("renderEventLine", () => {
  test("ATTEMPTED shows the one-lined SQL and intent", () => {
    const line = renderEventLine(
      row({
        payload: { sql_raw: "SELECT *\nFROM users", sql_fingerprint: "0".repeat(16) },
        agent_intent: "check seed data",
      }),
      plain,
    );
    expect(line).toContain("ATTEMPT");
    expect(line).toContain("SELECT * FROM users");
    expect(line).toContain("— check seed data");
    expect(line).toContain("qid=Q1");
  });

  test("DENY shows rule + reason; ALLOW shows statement + tables", () => {
    const deny = renderEventLine(
      row({
        event_type: "DECIDED",
        payload: { decision: "DENY", policy_rule: "tenant_scope_missing", reason: "missing predicate" },
      }),
      plain,
    );
    expect(deny).toContain("DENIED");
    expect(deny).toContain("tenant_scope_missing");
    expect(deny).toContain("missing predicate");

    const allow = renderEventLine(
      row({
        event_type: "DECIDED",
        payload: { decision: "ALLOW", statement_type: "SELECT", tables_touched: ["users", "orders"] },
      }),
      plain,
    );
    expect(allow).toContain("ALLOWED");
    expect(allow).toContain("SELECT tables=users,orders");
  });

  test("default db and self-host tenant are elided from meta; others shown", () => {
    const quiet = renderEventLine(row({ payload: { sql_raw: "SELECT 1" } }), plain);
    expect(quiet).not.toContain("db=");
    expect(quiet).not.toContain("tenant=");

    const loud = renderEventLine(
      row({ database: "analytics", tenant_id: "t-42", payload: { sql_raw: "SELECT 1" } }),
      plain,
    );
    expect(loud).toContain("db=analytics");
    expect(loud).toContain("tenant=t-42");
  });

  test("FAILED shows the SQLSTATE class and one-lined message", () => {
    const line = renderEventLine(
      row({
        event_type: "FAILED",
        payload: { exec_ms: 3, overhead_ms: 1, error_class: "42P01", error_message: "relation\n  does not exist" },
      }),
      plain,
    );
    expect(line).toContain("FAILED");
    expect(line).toContain("42P01");
    expect(line).toContain("relation does not exist");
  });

  test("POLICY_RELOADED shows the source", () => {
    const line = renderEventLine(
      row({ event_type: "POLICY_RELOADED", payload: { source: "admin_endpoint", table_access: null } }),
      plain,
    );
    expect(line).toContain("POLICY");
    expect(line).toContain("admin_endpoint");
  });

  test("unknown future event types render generically instead of crashing", () => {
    const line = renderEventLine(row({ event_type: "SOMETHING_NEW" }), plain);
    expect(line).toContain("SOMETHING_NEW");
  });
});

describe("renderRowsTable", () => {
  test("aligns columns and stringifies null/objects", () => {
    const lines = renderRowsTable(
      [
        { id: 1, name: "ada", meta: null },
        { id: 22, name: "grace", meta: { a: 1 } },
      ],
      plain,
    );
    expect(lines[0]).toMatch(/^id +name +meta/);
    expect(lines[2]).toContain("NULL");
    expect(lines[3]).toContain('{"a":1}');
    // Header/cells padded to a common width per column.
    expect(lines[2]!.indexOf("ada")).toBe(lines[3]!.indexOf("grace"));
  });

  test("empty result renders a row-count placeholder", () => {
    expect(renderRowsTable([], plain)).toEqual(["(0 rows)"]);
  });
});
