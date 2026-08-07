// Token expiry sweeper — flips mcp_tokens rows past their expires_at to
// status='expired' so the dashboard renders truthfully.
//
// PR2 of mcp_url_auth_security (Codex review #7). The durable enforcement
// of expiry lives in the runtime lookup path (resolveByToken's WHERE
// filters status='active' AND (expires_at IS NULL OR expires_at > NOW())
// — so an unswept expired row can NEVER authorize a request. This
// sweeper's job is dashboard truthfulness + revoked_at ordering for
// audit: when the operator views the token list, expired tokens should
// be visibly distinct from active ones, and the revoked_at timestamp
// should order them correctly against revocations and other lifecycle
// events.
//
// Co-located with the regional indexer process (one sweeper per region,
// runs alongside Indexer in apps/web/src/lib/mcp-proxy.ts). Idempotent:
// each run flips only the still-active+past-due rows, so two ticks
// landing concurrently is a no-op on the second.

import { sql as drizzleSql } from "drizzle-orm";

import type { Db } from "./resolve.ts";

const DEFAULT_TICK_MS = 5 * 60_000;

export interface ExpirySweeperOptions {
  db: Db;
  /** Default 5 minutes. Cadence is dashboard-truthfulness latency, not
   *  security boundary — runtime lookup is the enforcement gate. */
  tickMs?: number;
  /** Injected for tests. */
  now?: () => number;
  /** Surfaced for operator alerting. The sweeper logs row counts via
   *  this hook on every non-trivial sweep so a long-tail expiry batch
   *  is visible in logs/metrics. Errors land here too. */
  onSweep?: (result: { affected: number }) => void;
  onError?: (err: unknown) => void;
}

/** Standalone sweeper service. Lifecycle mirrors Indexer:
 *  `start()` schedules ticks; `stop()` cancels the next tick. */
export class ExpirySweeper {
  private readonly db: Db;
  private readonly tickMs: number;
  private readonly onSweep: ((result: { affected: number }) => void) | undefined;
  private readonly onError: ((err: unknown) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: ExpirySweeperOptions) {
    this.db = opts.db;
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.onSweep = opts.onSweep;
    this.onError = opts.onError;
  }

  start(): void {
    if (this.timer) return;
    this.scheduleNextTick();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One pass over `mcp_tokens` AND `write_approvals`. Exposed for tests; the
   *  tick loop calls this on the configured cadence. */
  async tick(): Promise<{ affected: number }> {
    const tokens = await this.tickTokens();
    const approvals = await this.tickApprovals();
    const affected = tokens + approvals;
    if (affected > 0) this.onSweep?.({ affected });
    return { affected };
  }

  /** Flip pending write approvals whose window has closed.
   *
   *  Unlike the token sweep, this one is NOT merely cosmetic. A pending row that
   *  nobody ever answers would otherwise sit in the approvals queue forever,
   *  and the queue is the surface an approver is supposed to trust as "what is
   *  waiting on me". Expiry always denies — a request that timed out into a yes
   *  would be a denial-of-attention attack on the control plane — so this only
   *  ever moves work OUT of a human's inbox, never grants anything.
   *
   *  The gate also checks the deadline on read, so an unswept row can never
   *  authorize a write; this is what keeps the queue honest. */
  private async tickApprovals(): Promise<number> {
    try {
      const result = await this.db.execute(drizzleSql`
        UPDATE write_approvals
           SET status = 'expired',
               decided_at = NOW()
         WHERE status = 'pending'
           AND expires_at < NOW()
      `);
      return countOf(result);
    } catch (err) {
      this.onError?.(err);
      return 0;
    }
  }

  private async tickTokens(): Promise<number> {
    try {
      // NOW() is the DB clock — keeps the predicate consistent with
      // resolveByToken's filter (also NOW()) so a token never lands in
      // a state where the sweeper has flipped it but the lookup still
      // accepts it, or vice versa. revoked_reason='expired' distinguishes
      // this transition from user-action revokes in the audit log.
      const result = await this.db.execute(drizzleSql`
        UPDATE mcp_tokens
           SET status = 'expired',
               revoked_at = NOW(),
               revoked_reason = 'expired'
         WHERE status = 'active'
           AND expires_at IS NOT NULL
           AND expires_at < NOW()
      `);
      // postgres-js returns row count via a `count` property on the
      // returned Result-like value. Drizzle's typing is loose here;
      // tolerate either shape so tests / drivers that return a different
      // count surface still feed the onSweep hook.
      return countOf(result);
    } catch (err) {
      this.onError?.(err);
      return 0;
    }
  }

  private scheduleNextTick(): void {
    const t = setTimeout(() => {
      void this.tick().finally(() => {
        if (this.timer !== null) this.scheduleNextTick();
      });
    }, this.tickMs);
    if (typeof t === "object" && t && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
    this.timer = t;
  }
}

// postgres-js returns row count via a `count` property on the returned
// Result-like value. Drizzle's typing is loose here; tolerate either shape so
// tests / drivers with a different count surface still feed the onSweep hook.
function countOf(result: unknown): number {
  return typeof (result as { count?: unknown }).count === "number"
    ? (result as { count: number }).count
    : 0;
}
