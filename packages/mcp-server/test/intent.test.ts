// resolveAgentIntent + extractSqlCommentIntent unit tests.
//
// Three channels in priority: MCP `_meta.intent` → SQL comment hint →
// HTTP `X-Midplane-Intent` header. Sanitization caps the value at 500
// chars, strips control chars, and rejects empty-after-trim.

import { describe, expect, test } from "bun:test";
import {
  INTENT_HEADER,
  INTENT_MAX_LENGTH,
  extractSqlCommentIntent,
  resolveAgentIntent,
} from "../src/intent.ts";

describe("resolveAgentIntent — channel priority", () => {
  test("MCP _meta.intent wins when populated", () => {
    const r = resolveAgentIntent({
      meta: { intent: "list active sessions" },
      sql: "/* midplane:intent=\"comment intent\" */ SELECT 1",
      headers: { [INTENT_HEADER]: "header intent" },
    });
    expect(r.intent).toEqual({
      value: "list active sessions",
      source: "mcp_meta",
    });
    // We do NOT strip when meta wins — leaving the comment is harmless
    // and avoids surprising side effects on a channel the agent didn't
    // pick.
    expect(r.cleanSql).toBe(
      "/* midplane:intent=\"comment intent\" */ SELECT 1",
    );
  });

  test("SQL comment wins over HTTP header when meta is absent", () => {
    const r = resolveAgentIntent({
      sql: "/* midplane:intent=\"investigating slow query\" */ SELECT * FROM users",
      headers: { [INTENT_HEADER]: "should not win" },
    });
    expect(r.intent).toEqual({
      value: "investigating slow query",
      source: "sql_comment",
    });
    expect(r.cleanSql).toBe("SELECT * FROM users");
  });

  test("HTTP header wins when meta and SQL comment are absent", () => {
    const r = resolveAgentIntent({
      sql: "SELECT 1",
      headers: { [INTENT_HEADER]: "ad-hoc query" },
    });
    expect(r.intent).toEqual({
      value: "ad-hoc query",
      source: "http_header",
    });
    expect(r.cleanSql).toBe("SELECT 1");
  });

  test("no channel populated → null intent, sql untouched", () => {
    const r = resolveAgentIntent({ sql: "SELECT 1" });
    expect(r.intent).toBeNull();
    expect(r.cleanSql).toBe("SELECT 1");
  });

  test("empty/whitespace meta intent falls through to next channel", () => {
    const r = resolveAgentIntent({
      meta: { intent: "   " },
      sql: "/* midplane:intent=\"backfill check\" */ SELECT 1",
    });
    expect(r.intent).toEqual({
      value: "backfill check",
      source: "sql_comment",
    });
  });

  test("non-string meta.intent ignored", () => {
    const r = resolveAgentIntent({
      meta: { intent: 42 },
      sql: "SELECT 1",
      headers: { [INTENT_HEADER]: "fallback" },
    });
    expect(r.intent).toEqual({ value: "fallback", source: "http_header" });
  });
});

describe("resolveAgentIntent — sanitization", () => {
  test("trims surrounding whitespace", () => {
    const r = resolveAgentIntent({
      sql: "SELECT 1",
      meta: { intent: "  hello  " },
    });
    expect(r.intent?.value).toBe("hello");
  });

  test("strips control chars including tab/LF/CR", () => {
    const r = resolveAgentIntent({
      sql: "SELECT 1",
      meta: { intent: "line one\nline two\there\rthere" },
    });
    expect(r.intent?.value).toBe("line oneline twoherethere");
  });

  test("truncates to INTENT_MAX_LENGTH (does not reject)", () => {
    const long = "a".repeat(INTENT_MAX_LENGTH + 50);
    const r = resolveAgentIntent({ sql: "SELECT 1", meta: { intent: long } });
    expect(r.intent?.value.length).toBe(INTENT_MAX_LENGTH);
  });

  test("control-only string sanitizes to null", () => {
    const r = resolveAgentIntent({
      sql: "SELECT 1",
      meta: { intent: "\x00\x01\x02" },
    });
    expect(r.intent).toBeNull();
  });
});

describe("resolveAgentIntent — header normalization", () => {
  test("case-insensitive header lookup", () => {
    const r = resolveAgentIntent({
      sql: "SELECT 1",
      headers: { "X-Midplane-Intent": "case test" },
    });
    expect(r.intent?.value).toBe("case test");
  });

  test("array-valued header takes first non-empty", () => {
    const r = resolveAgentIntent({
      sql: "SELECT 1",
      headers: { [INTENT_HEADER]: ["", "first non-empty", "second"] },
    });
    expect(r.intent?.value).toBe("first non-empty");
  });

  test("missing headers map → no header channel fires", () => {
    const r = resolveAgentIntent({ sql: "SELECT 1" });
    expect(r.intent).toBeNull();
  });
});

describe("extractSqlCommentIntent — comment shapes", () => {
  test("/* midplane:intent=\"...\" */ at head", () => {
    const r = extractSqlCommentIntent(
      "/* midplane:intent=\"hello\" */ SELECT 1",
    );
    expect(r.intent).toBe("hello");
    expect(r.cleanSql).toBe("SELECT 1");
  });

  test("single-quoted variant", () => {
    const r = extractSqlCommentIntent(
      "/* midplane:intent='hello' */SELECT 1",
    );
    expect(r.intent).toBe("hello");
    expect(r.cleanSql).toBe("SELECT 1");
  });

  test("-- midplane:intent: ... single-line variant", () => {
    const r = extractSqlCommentIntent(
      "-- midplane:intent: list users\nSELECT * FROM users",
    );
    expect(r.intent).toBe("list users");
    expect(r.cleanSql).toBe("SELECT * FROM users");
  });

  test("preserves leading whitespace on cleaned SQL only when no hint", () => {
    const r = extractSqlCommentIntent("  SELECT 1");
    expect(r.intent).toBeNull();
    expect(r.cleanSql).toBe("  SELECT 1");
  });

  test("hint mid-query (after a non-comment token) is ignored — comment stays", () => {
    const r = extractSqlCommentIntent(
      "SELECT 1 /* midplane:intent=\"sneaky\" */",
    );
    expect(r.intent).toBeNull();
    expect(r.cleanSql).toBe("SELECT 1 /* midplane:intent=\"sneaky\" */");
  });

  test("non-midplane head comment is preserved when no hint follows", () => {
    const r = extractSqlCommentIntent(
      "/* unrelated */ SELECT 1",
    );
    expect(r.intent).toBeNull();
    // No hint → leave the head intact; we only strip when we successfully
    // extracted an intent (we don't want to mutate the SQL otherwise).
    expect(r.cleanSql).toBe("/* unrelated */ SELECT 1");
  });

  test("hint after a non-midplane head comment still wins, prior comment preserved", () => {
    const r = extractSqlCommentIntent(
      "/* unrelated */ /* midplane:intent=\"won\" */ SELECT 1",
    );
    expect(r.intent).toBe("won");
    // Only the midplane comment is removed — the unrelated head comment
    // stays put because it might be an optimizer/proxy directive.
    expect(r.cleanSql).toBe("/* unrelated */ SELECT 1");
  });

  test("preserves Postgres optimizer-hint comment that precedes the midplane hint", () => {
    // `/*+ ... */` is the pg_hint_plan extension's optimizer-hint syntax —
    // dropping it would silently change query plans. Regression for the
    // earlier strip-everything-leading behavior.
    const r = extractSqlCommentIntent(
      "/*+ IndexScan(users users_pkey) */ /* midplane:intent=\"probe\" */ SELECT * FROM users",
    );
    expect(r.intent).toBe("probe");
    expect(r.cleanSql).toBe(
      "/*+ IndexScan(users users_pkey) */ SELECT * FROM users",
    );
  });

  test("preserves a non-midplane comment that follows the midplane hint", () => {
    const r = extractSqlCommentIntent(
      "/* midplane:intent=\"x\" */ /*+ Leading hint */ SELECT 1",
    );
    expect(r.intent).toBe("x");
    expect(r.cleanSql).toBe("/*+ Leading hint */ SELECT 1");
  });

  test("unterminated block comment leaves SQL untouched (parser will reject)", () => {
    const r = extractSqlCommentIntent("/* never ends");
    expect(r.intent).toBeNull();
    expect(r.cleanSql).toBe("/* never ends");
  });

  test("intent value is sanitized + truncated", () => {
    const r = extractSqlCommentIntent(
      `/* midplane:intent="${"x".repeat(INTENT_MAX_LENGTH + 10)}" */ SELECT 1`,
    );
    expect(r.intent?.length).toBe(INTENT_MAX_LENGTH);
  });
});
