// query tool tests — drive Engine + mock executor through tool handler.

import { describe, expect, test } from "bun:test";
import { handleQuery } from "../../src/tools/query.ts";
import { makeTestEngine, baseCtx, MemoryAuditWriter } from "../_helpers.ts";
import { AuditUnavailableError } from "@midplane/engine";

describe("query tool — ALLOW path", () => {
  test("rows returned as structured text content", async () => {
    const { engine, executor } = makeTestEngine();
    executor.result = { rows: [{ id: 1, email: "a@b" }, { id: 2, email: "c@d" }], rowCount: 2 };

    const out = await handleQuery({ engine, ctx: baseCtx, args: { sql: "SELECT id, email FROM users" } });

    expect(out.isError).toBeFalsy();
    expect(out.content[0]?.type).toBe("text");
    const payload = JSON.parse((out.content[0] as { text: string }).text);
    expect(payload.allowed).toBe(true);
    expect(payload.rowCount).toBe(2);
    expect(payload.rows).toEqual([{ id: 1, email: "a@b" }, { id: 2, email: "c@d" }]);
    expect(payload.auditId).toBeTruthy();
  });
});

describe("query tool — DENY path", () => {
  test("write denial returns isError=true with policy_rule + reason", async () => {
    const { engine, executor } = makeTestEngine();
    const out = await handleQuery({ engine, ctx: baseCtx, args: { sql: "DELETE FROM users" } });

    expect(out.isError).toBe(true);
    const payload = JSON.parse((out.content[0] as { text: string }).text);
    expect(payload.allowed).toBe(false);
    expect(payload.policy_rule).toBe("writes_require_approval");
    expect(payload.reason).toMatch(/read-only/);
    expect(payload.auditId).toBeTruthy();
    expect(executor.calls.length).toBe(0);
  });

  test("multi-statement denial includes policy_rule=multi_statement", async () => {
    const { engine } = makeTestEngine();
    const out = await handleQuery({
      engine,
      ctx: baseCtx,
      args: { sql: "SELECT 1; DROP TABLE users;" },
    });
    expect(out.isError).toBe(true);
    const payload = JSON.parse((out.content[0] as { text: string }).text);
    expect(payload.policy_rule).toBe("multi_statement");
  });

  test("parse error denial includes policy_rule=parse_error", async () => {
    const { engine } = makeTestEngine();
    const out = await handleQuery({
      engine,
      ctx: baseCtx,
      args: { sql: "this is not sql" },
    });
    expect(out.isError).toBe(true);
    const payload = JSON.parse((out.content[0] as { text: string }).text);
    expect(payload.policy_rule).toBe("parse_error");
  });
});

describe("query tool — infrastructure failure", () => {
  test("AuditUnavailableError surfaces as MCP error with code=audit_unavailable", async () => {
    const audit = new MemoryAuditWriter();
    audit.failOn = "ATTEMPTED";
    const { engine } = makeTestEngine({ audit });

    await expect(
      handleQuery({ engine, ctx: baseCtx, args: { sql: "SELECT 1" } }),
    ).rejects.toMatchObject({
      // We re-throw via a structured object the transport layer maps; the
      // engine's AuditUnavailableError is preserved (instanceof check).
      code: "audit_unavailable",
    });
  });

  test("executor throw surfaces FAILED audit + propagates as MCP error", async () => {
    const { engine, executor, audit } = makeTestEngine();
    executor.shouldThrow = { sqlstate: "42P01", message: "relation x does not exist" };
    await expect(
      handleQuery({ engine, ctx: baseCtx, args: { sql: "SELECT * FROM x" } }),
    ).rejects.toThrow(/relation x does not exist/);
    expect(audit.events.map((e) => e.event_type)).toEqual([
      "ATTEMPTED",
      "DECIDED",
      "FAILED",
    ]);
  });
});

describe("query tool — rejects non-AuditUnavailableError as transport error", () => {
  test("infra audit error type is preserved (not silently absorbed into a Decision)", async () => {
    const audit = new MemoryAuditWriter();
    audit.failOn = "DECIDED";
    const { engine } = makeTestEngine({ audit });

    let caught: unknown = null;
    try {
      await handleQuery({ engine, ctx: baseCtx, args: { sql: "SELECT 1" } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AuditUnavailableError);
  });
});
