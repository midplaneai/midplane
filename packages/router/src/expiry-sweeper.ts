// Expiry sweeper — flips mcp_tokens rows past their expires_at to
// status='expired', and pending write_approvals past their deadline to
// status='expired', so the dashboard renders truthfully.
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
// Cadence is deliberately traffic-driven, NOT timer-driven. The control
// plane's Postgres is Neon, which scales to zero after 5 idle minutes; a
// 5-minute timer here kept both regional computes awake around the clock
// with zero users (each tick opened a connection and ran two UPDATEs that
// matched nothing). So:
//   - The one-shot `sweepExpiredTokens` / `sweepExpiredApprovals` functions
//     run inline from the read paths that need a truthful answer (the token
//     list, the approvals queue) — those reads already have the compute
//     awake, so the sweep costs one extra statement and no wake-up. A read
//     passes its own tenant as the scope, so a GET never writes outside the
//     workspace that issued it; only the backstop sweeps region-wide.
//   - `ExpirySweeper` keeps a slow backstop tick (default 6h) so audit
//     timestamps land within hours even in a workspace nobody opens. Do not
//     lower it back toward the Neon idle window without a reason worth
//     ~$40/month/region.
//
// The backstop is per PROCESS, not per region: every web machine that has
// built its proxy context (apps/web/src/lib/mcp-proxy.ts) runs its own
// timer, phased by its own boot, and a deploy resets it. So N always-on
// machines wake the compute up to N times per tick, and a region that
// deploys more often than the tick never runs the backstop at all — which
// is fine, because the read paths carry the truthfulness. Idempotent: each
// run flips only the still-active+past-due rows, so two sweeps landing
// concurrently is a no-op on the second.
//
// Both sweeps stamp the row's own deadline (expires_at) into revoked_at /
// decided_at, never the sweep time. With a 5-minute timer the difference was
// bounded; with traffic-driven sweeps it is not, and the Decided tab renders
// that timestamp — "expired 30 seconds ago" for a request that timed out
// yesterday would be a lie.

import { sql as drizzleSql } from "drizzle-orm";

import type { Db } from "./resolve.ts";

/** Anything that can run one raw statement: the pooled Db, or a transaction
 *  handle when a caller needs the sweep inside its own txn (revokeToken). */
type Executor = Pick<Db, "execute">;

/** Backstop cadence. Must stay well above Neon's 5-minute scale-to-zero
 *  window — see the header comment. */
export const DEFAULT_TICK_MS = 6 * 60 * 60_000;

export interface ExpirySweeperOptions {
  db: Db;
  /** Default 6 hours. Cadence is a backstop for audit-timestamp latency,
   *  not a security boundary — runtime lookup is the enforcement gate, and
   *  the dashboard read paths sweep inline before rendering. */
  tickMs?: number;
  /** Surfaced for operator alerting. The sweeper logs row counts via
   *  this hook on every non-trivial sweep so a long-tail expiry batch
   *  is visible in logs/metrics. Errors land here too. */
  onSweep?: (result: { affected: number }) => void;
  onError?: (err: unknown) => void;
}

/** Flip active tokens whose expires_at has passed. Returns the row count.
 *  Throws on DB error — callers decide whether that is fatal (the backstop
 *  tick logs and moves on; a read path logs and renders anyway). `scope`
 *  narrows the write to one project (mcp_tokens_project_status_idx); the
 *  backstop passes none and walks mcp_tokens_expires_at_idx instead.
 *
 *  NOW() is the DB clock — keeps the predicate consistent with
 *  resolveByToken's filter (also NOW()) so a token never lands in a state
 *  where the sweeper has flipped it but the lookup still accepts it, or
 *  vice versa. revoked_at is the deadline itself (see the header), and
 *  revoked_reason='expired' distinguishes this transition from user-action
 *  revokes in the audit log. */
export async function sweepExpiredTokens(
  db: Executor,
  scope?: { projectId: string },
): Promise<number> {
  const scopeClause = scope
    ? drizzleSql`AND project_id = ${scope.projectId}`
    : drizzleSql``;
  const result = await db.execute(drizzleSql`
    UPDATE mcp_tokens
       SET status = 'expired',
           revoked_at = expires_at,
           revoked_reason = 'expired'
     WHERE status = 'active'
       AND expires_at IS NOT NULL
       AND expires_at < NOW()
       ${scopeClause}
  `);
  return countOf(result);
}

/** Flip pending write approvals whose window has closed. Returns the count.
 *
 *  Unlike the token sweep, this one is NOT merely cosmetic. A pending row that
 *  nobody ever answers would otherwise sit in the approvals queue forever,
 *  and the queue is the surface an approver is supposed to trust as "what is
 *  waiting on me". Expiry always denies — a request that timed out into a yes
 *  would be a denial-of-attention attack on the control plane — so this only
 *  ever moves work OUT of a human's inbox, never grants anything.
 *
 *  The gate also checks the deadline on read, so an unswept row can never
 *  authorize a write; this is what keeps the queue honest. `scope` narrows
 *  the write to one workspace (write_approvals_queue_idx leads with
 *  customer_id, region, status); the backstop passes none. */
export async function sweepExpiredApprovals(
  db: Executor,
  scope?: { customerId: string; region: string },
): Promise<number> {
  const scopeClause = scope
    ? drizzleSql`AND customer_id = ${scope.customerId} AND region = ${scope.region}`
    : drizzleSql``;
  const result = await db.execute(drizzleSql`
    UPDATE write_approvals
       SET status = 'expired',
           decided_at = expires_at
     WHERE status = 'pending'
       AND expires_at < NOW()
       ${scopeClause}
  `);
  return countOf(result);
}

/** Backstop sweeper service. Lifecycle mirrors Indexer:
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
   *  tick loop calls this on the configured cadence. A failure on one table
   *  is reported through onError and does not stop the other. */
  async tick(): Promise<{ affected: number }> {
    const tokens = await this.guarded(() => sweepExpiredTokens(this.db));
    const approvals = await this.guarded(() => sweepExpiredApprovals(this.db));
    const affected = tokens + approvals;
    if (affected > 0) this.onSweep?.({ affected });
    return { affected };
  }

  private async guarded(sweep: () => Promise<number>): Promise<number> {
    try {
      return await sweep();
    } catch (err) {
      this.onError?.(err);
      return 0;
    }
  }

  private scheduleNextTick(): void {
    const t = setTimeout(() => {
      void this.tick().finally(() => {
        // Reschedule only if THIS timer is still the live one. A stop() (or
        // stop()+start()) during the in-flight tick replaces or clears it,
        // and rescheduling then would leave a second loop that stop() can
        // never reach.
        if (this.timer === t) this.scheduleNextTick();
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
