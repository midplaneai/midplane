// Unit coverage for the expiry sweeper.
//
// It now sweeps TWO tables per tick: mcp_tokens (dashboard truthfulness) and
// write_approvals (a pending row nobody answers must not sit in the approvals
// queue forever).
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
    expect(calls).toHaveLength(2);
    // The SQL filters active+past-due rows and sets status='expired'
    // with revoked_reason='expired'. NOW() ensures the sweeper matches
    // the runtime lookup's clock so there's no drift window.
    const sql = calls.find((c) => c.includes("mcp_tokens"))!;
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
    // One tick sweeps two tables; the fake returns 3 rows for each.
    expect(onSweep).toHaveBeenCalledWith({ affected: 6 });
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
    expect(errors).toHaveLength(2);
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

  it("sweeps stale pending approvals out of the queue", async () => {
    // Not cosmetic, unlike the token sweep: an unanswered request would
    // otherwise sit in /approvals forever, and the queue is what an approver
    // trusts as "what is waiting on me".
    const { db, calls } = makeFakeDb(0);
    await new ExpirySweeper({ db }).tick();

    const sql = calls.find((c) => c.includes("write_approvals"))!;
    expect(sql).toContain("UPDATE write_approvals");
    expect(sql).toContain("status = 'expired'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("expires_at < NOW()");
    // Expiry always DENIES. A sweeper that could approve anything would be a
    // way to get a write executed by waiting.
    expect(sql).not.toContain("'approved'");
  });

  it("a failure sweeping one table does not stop the other", async () => {
    let n = 0;
    const db = {
      async execute(): Promise<unknown> {
        n += 1;
        if (n === 1) throw new Error("tokens table locked");
        return { count: 2 };
      },
    } as unknown as Db;
    const errors: unknown[] = [];
    const sweeper = new ExpirySweeper({ db, onError: (e) => errors.push(e) });

    const result = await sweeper.tick();
    expect(errors).toHaveLength(1);
    expect(result.affected).toBe(2);
  });
});
