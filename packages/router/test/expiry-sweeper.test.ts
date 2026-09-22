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
//
// The timer is a slow BACKSTOP: the dashboard read paths call the one-shot
// sweep functions inline. A fast timer here is what kept the Neon control
// plane compute from ever scaling to zero, so the default cadence is pinned.

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TICK_MS,
  ExpirySweeper,
  sweepExpiredApprovals,
  sweepExpiredTokens,
} from "../src/expiry-sweeper.ts";
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
      // Drizzle's sql template produces a structured object; render its
      // chunks (recursing into nested sql`` fragments, inlining params) so
      // we can assert against the SQL text.
      const render = (chunks: unknown[]): string =>
        chunks
          .map((c) => {
            if (typeof c === "string") return c;
            const o = c as { value?: unknown; queryChunks?: unknown[] };
            if (Array.isArray(o.queryChunks)) return render(o.queryChunks);
            if (Array.isArray(o.value)) return o.value.join("");
            return o.value === undefined ? "" : String(o.value);
          })
          .join("");
      let text = "";
      if (q && typeof q === "object") {
        const r = q as { queryChunks?: unknown[]; sql?: string };
        if (typeof r.sql === "string") text = r.sql;
        else if (Array.isArray(r.queryChunks)) text = render(r.queryChunks);
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
    // The stamp is the row's own deadline, never the sweep time: with
    // traffic-driven sweeps the gap between the two is unbounded.
    expect(sql).toContain("revoked_at = expires_at");
    expect(sql).not.toContain("revoked_at = NOW()");
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
    expect(sql).toContain("decided_at = expires_at");
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

  it("the backstop cadence stays far above Neon's 5-minute scale-to-zero window", () => {
    // A 5-minute tick opened a connection and ran two no-op UPDATEs on both
    // regional computes around the clock, so they never suspended. The read
    // paths sweep inline; the timer only bounds audit-timestamp latency.
    expect(DEFAULT_TICK_MS).toBeGreaterThanOrEqual(60 * 60_000);
  });

  it("the one-shot sweeps are exported for inline use and report the row count", async () => {
    const { db, calls, setAffected } = makeFakeDb(0);
    setAffected(4);
    expect(await sweepExpiredTokens(db)).toBe(4);
    expect(await sweepExpiredApprovals(db)).toBe(4);
    expect(calls[0]).toContain("UPDATE mcp_tokens");
    expect(calls[1]).toContain("UPDATE write_approvals");
  });

  it("a read path's sweep is scoped to its own tenant; the backstop is not", async () => {
    // A member's page load must never write another workspace's rows. The
    // scope clause is the only thing standing between a GET and a region-wide
    // UPDATE, so pin both shapes.
    const { db, calls } = makeFakeDb(0);
    await sweepExpiredTokens(db, { projectId: "proj_1" });
    await sweepExpiredApprovals(db, { customerId: "cust_1", region: "eu" });
    await sweepExpiredTokens(db);
    await sweepExpiredApprovals(db);

    expect(calls[0]).toContain("AND project_id = proj_1");
    expect(calls[1]).toContain("AND customer_id = cust_1 AND region = eu");
    expect(calls[2]).not.toContain("project_id");
    expect(calls[3]).not.toContain("customer_id");
    // Scoping never loosens the deadline predicate.
    for (const sql of calls) expect(sql).toContain("expires_at < NOW()");
  });

  it("the backstop loop keeps rescheduling itself while it is running", async () => {
    // The stale-timer guard must not turn into "never reschedule": a second
    // tick has to follow the first without any stop()/start() in between.
    vi.useFakeTimers();
    try {
      let n = 0;
      const db = {
        async execute(): Promise<unknown> {
          n += 1;
          return { count: 0 };
        },
      } as unknown as Db;
      const sweeper = new ExpirySweeper({ db, tickMs: 1_000 });
      sweeper.start();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(n).toBe(2); // one tick = both tables
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(n).toBe(4);
      expect(vi.getTimerCount()).toBe(1);
      sweeper.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the one-shot sweeps throw so a caller can decide; the tick loop swallows", async () => {
    const db = {
      async execute() {
        throw new Error("postgres outage");
      },
    } as unknown as Db;
    await expect(sweepExpiredTokens(db)).rejects.toThrow("postgres outage");
    await expect(sweepExpiredApprovals(db)).rejects.toThrow("postgres outage");

    const errors: unknown[] = [];
    const result = await new ExpirySweeper({
      db,
      onError: (e) => errors.push(e),
    }).tick();
    expect(result.affected).toBe(0);
    expect(errors).toHaveLength(2);
  });

  it("stop()+start() during an in-flight tick leaves exactly one loop", async () => {
    // The in-flight tick's finally must reschedule only if ITS timer is still
    // the live one. Rescheduling on "timer !== null" left a second loop that
    // stop() could never reach.
    vi.useFakeTimers();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let n = 0;
      const db = {
        async execute(): Promise<unknown> {
          n += 1;
          if (n === 1) await gate; // hold the first tick open
          return { count: 0 };
        },
      } as unknown as Db;
      const sweeper = new ExpirySweeper({ db, tickMs: 1_000 });
      sweeper.start();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000); // tick fires, blocks on gate
      expect(vi.getTimerCount()).toBe(0);

      sweeper.stop();
      sweeper.start(); // a fresh loop while the old tick is still running
      expect(vi.getTimerCount()).toBe(1);

      release();
      for (let i = 0; i < 20; i++) await Promise.resolve(); // drain the finally
      expect(n).toBe(2); // the held tick ran to completion (both tables)
      expect(vi.getTimerCount()).toBe(1);

      sweeper.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
