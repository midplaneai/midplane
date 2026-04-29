// describe_table tool tests — identifier validation BEFORE engine sees it,
// canned information_schema.columns query routed through engine.handle().

import { describe, expect, test } from "bun:test";
import { handleDescribeTable } from "../../src/tools/describe-table.ts";
import { makeTestEngine, baseCtx } from "../_helpers.ts";

describe("describe_table tool", () => {
  test("returns columns from canned information_schema.columns query", async () => {
    const { engine, executor, audit } = makeTestEngine();
    executor.result = {
      rows: [
        { column_name: "id", data_type: "integer", is_nullable: "NO", column_default: null },
        { column_name: "email", data_type: "text", is_nullable: "YES", column_default: null },
      ],
      rowCount: 2,
    };

    const out = await handleDescribeTable({
      engine,
      ctx: baseCtx,
      args: { table: "users" },
    });

    expect(out.isError).toBeFalsy();
    const payload = JSON.parse((out.content[0] as { text: string }).text);
    expect(payload.columns).toEqual([
      { name: "id", type: "integer", nullable: false, default: null },
      { name: "email", type: "text", nullable: true, default: null },
    ]);

    expect(audit.events.map((e) => e.event_type)).toEqual([
      "ATTEMPTED",
      "DECIDED",
      "EXECUTED",
    ]);

    expect(executor.calls[0]?.sql).toMatch(/information_schema\.columns/i);
  });

  test("rejects table name with shell metachars BEFORE engine sees it", async () => {
    const { engine, executor, audit } = makeTestEngine();
    await expect(
      handleDescribeTable({
        engine,
        ctx: baseCtx,
        args: { table: "users; DROP TABLE users" },
      }),
    ).rejects.toThrow();
    // Engine never invoked: no audit events, no executor calls.
    expect(audit.events.length).toBe(0);
    expect(executor.calls.length).toBe(0);
  });

  test("rejects table name with quote", async () => {
    const { engine } = makeTestEngine();
    await expect(
      handleDescribeTable({ engine, ctx: baseCtx, args: { table: "users'--" } }),
    ).rejects.toThrow();
  });

  test("rejects empty table name", async () => {
    const { engine } = makeTestEngine();
    await expect(
      handleDescribeTable({ engine, ctx: baseCtx, args: { table: "" } }),
    ).rejects.toThrow();
  });

  test("rejects schema with metachars", async () => {
    const { engine, executor } = makeTestEngine();
    await expect(
      handleDescribeTable({
        engine,
        ctx: baseCtx,
        args: { table: "users", schema: "public; --" },
      }),
    ).rejects.toThrow();
    expect(executor.calls.length).toBe(0);
  });
});
