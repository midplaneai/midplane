// Unit coverage for the mcp_tokens expiry sweeper.
//
// The sweeper is a dashboard-truthfulness mechanism: durable enforcement
// of expiry lives in resolveByToken's WHERE filter (NOW() vs
// expires_at). Tests here just exercise the UPDATE shape + lifecycle
// (start/stop), not the runtime gate.

import { describe, expect, it, vi } from "vitest";

import { ExpirySweeper } from "../src/expiry-sweeper.ts";
import type { Db } from "../src/resolve.ts";

/** Tiny fake Db that captures execute() calls and returns a configurable
 *  affected-row count. */
function makeFakeDb(initialAffected = 0): {
  db: Db;
  calls: string[];
  setAffected(n: number): void;
} {
  let affected = initialAffected;
  const calls: string[] = [];
  const db = {
    async execute(q: unknown): Promise<unknown> {
      // Drizzle's sql template produces a structured object; pull out
      // the chunks so we can assert against the rendered SQL.
      let text = "";
      if (q && typeof q === "object") {
        const r = q as { queryChunks?: unknown[]; sql?: string };
        if (typeof r.sql === "string") text = r.sql;
        else if (Array.isArray(r.queryChunks)) {
          text = r.queryChunks
            .map((c) =>
              typeof c === "string" ? c : (c as { value?: string }).value ?? "",
            )
            .join("");
        }
      }
      calls.push(text);
      return { count: affected };
    },
  } as unknown as Db;
  return {
    db,
    calls,
    setAffected(n: number) {
      affected = n;
    },
  };
}

describe("ExpirySweeper", () => {
  it("issues the expected UPDATE with NOW()-based predicate", async () => {
    const { db, calls } = makeFakeDb(0);
    const sweeper = new ExpirySweeper({ db });
    await sweeper.tick();
    expect(calls).toHaveLength(1);
    // The SQL filters active+past-due rows and sets status='expired'
    // with revoked_reason='expired'. NOW() ensures the sweeper matches
    // the runtime lookup's clock so there's no drift window.
    const sql = calls[0]!;
    expect(sql).toContain("UPDATE mcp_tokens");
    expect(sql).toContain("status = 'expired'");
    expect(sql).toContain("revoked_reason = 'expired'");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("expires_at IS NOT NULL");
    expect(sql).toContain("expires_at < NOW()");
  });

  it("fires onSweep with the affected count only when > 0", async () => {
    const { db, setAffected } = makeFakeDb(0);
    const onSweep = vi.fn();
    const sweeper = new ExpirySweeper({ db, onSweep });

    await sweeper.tick();
    expect(onSweep).not.toHaveBeenCalled();

    setAffected(3);
    await sweeper.tick();
    expect(onSweep).toHaveBeenCalledTimes(1);
    expect(onSweep).toHaveBeenCalledWith({ affected: 3 });
  });

  it("surfaces errors through onError without throwing", async () => {
    const db = {
      async execute() {
        throw new Error("postgres outage");
      },
    } as unknown as Db;
    const errors: unknown[] = [];
    const sweeper = new ExpirySweeper({
      db,
      onError: (err) => errors.push(err),
    });
    const result = await sweeper.tick();
    expect(result.affected).toBe(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("postgres outage");
  });

  it("start() and stop() are idempotent", async () => {
    const { db } = makeFakeDb(0);
    const sweeper = new ExpirySweeper({ db, tickMs: 60_000 });
    sweeper.start();
    sweeper.start(); // second start should be a no-op (no double-tick)
    sweeper.stop();
    sweeper.stop(); // second stop should also be a no-op
  });
});
