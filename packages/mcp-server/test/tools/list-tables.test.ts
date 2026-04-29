// list_tables tool tests — verifies routing through engine.handle()
// (parse → policy → audit → execute), canned information_schema query.

import { describe, expect, test } from "bun:test";
import { handleListTables } from "../../src/tools/list-tables.ts";
import { makeTestEngine, baseCtx } from "../_helpers.ts";

describe("list_tables tool", () => {
  test("calls executor with information_schema query and returns rows", async () => {
    const { engine, executor, audit } = makeTestEngine();
    executor.result = {
      rows: [
        { table_schema: "public", table_name: "users" },
        { table_schema: "public", table_name: "posts" },
      ],
      rowCount: 2,
    };

    const out = await handleListTables({ engine, ctx: baseCtx, args: {} });

    expect(out.isError).toBeFalsy();
    const payload = JSON.parse((out.content[0] as { text: string }).text);
    expect(payload.tables).toEqual([
      { schema: "public", name: "users" },
      { schema: "public", name: "posts" },
    ]);

    // Routed through engine: ATTEMPTED + DECIDED + EXECUTED were written.
    expect(audit.events.map((e) => e.event_type)).toEqual([
      "ATTEMPTED",
      "DECIDED",
      "EXECUTED",
    ]);

    // Executor saw an information_schema SELECT (not raw user SQL).
    expect(executor.calls[0]?.sql).toMatch(/information_schema\.tables/i);
  });

  test("schema arg defaults to 'public' and is embedded after regex check", async () => {
    const { engine, executor } = makeTestEngine();
    executor.result = { rows: [], rowCount: 0 };
    await handleListTables({ engine, ctx: baseCtx, args: {} });
    expect(executor.calls[0]?.sql).toMatch(/'public'/);
  });

  test("schema with shell metachars is rejected before engine sees it", async () => {
    const { engine, executor } = makeTestEngine();
    await expect(
      handleListTables({ engine, ctx: baseCtx, args: { schema: "public; DROP TABLE users" } }),
    ).rejects.toThrow();
    expect(executor.calls.length).toBe(0);
  });
});
