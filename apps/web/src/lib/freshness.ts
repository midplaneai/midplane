// Freshness signal for the dashboard's per-project dot. Two states
// for now, matching the design vocabulary in DESIGN.md:
//   - "live" → --allow: indexer has not reported a fresh error.
//              Includes "awaiting first query" — the project is ready,
//              the agent just hasn't called yet. The meta line on the row
//              tells the difference.
//   - "down" → --deny:  indexer reports an error newer than its last
//                       successful drain (or has never drained at all).
//
// A "stale" state will come back when we have a real signal for it in
// production; the previous "no traffic in >1h → amber" rule fired as a
// scary warning right after creation, which is the wrong UX.
//
// Inputs are the per-project slice of indexer_cursors. The dashboard is
// server-rendered for PR-B; 60s client polling lands in PR-C and will reuse
// this same function.

// "paused" is a project-level override, not an indexer signal:
// computeFreshness never returns it (it only reads cursor state). The
// project workspace computes `conn.pausedAt ? "paused" : freshness` for
// the rail dot, so a paused project reads amber/"Paused" regardless of
// indexer freshness.
export type Freshness = "live" | "down" | "paused";

export interface FreshnessInput {
  /** Last successful indexer drain. Null = the indexer has never run for
   *  this token; usually because no agent has ever connected yet. */
  lastIndexedAt: Date | null;
  /** Last error seen by the indexer. Null = no error has ever occurred or
   *  it has since been cleared. */
  lastErrorAt: Date | null;
}

export function computeFreshness({
  lastIndexedAt,
  lastErrorAt,
}: FreshnessInput): Freshness {
  // Error newer than the last good drain → indexer is stuck on this token.
  if (lastErrorAt && (!lastIndexedAt || lastErrorAt > lastIndexedAt)) {
    return "down";
  }
  return "live";
}

/** Project-level display state for the freshness dot. A non-null
 *  `pausedAt` is a deliberate owner action — the reversible kill switch —
 *  and overrides the indexer signal: a paused project reads "paused"
 *  (amber), never "live"/"down". This is the single source of truth for the
 *  override so every render site (workspace rail, dashboard header pill,
 *  dashboard db-row dots) stays in lockstep instead of each re-deriving it. */
export function resolveFreshness(
  cursor: FreshnessInput,
  pausedAt: Date | null,
): Freshness {
  if (pausedAt != null) return "paused";
  return computeFreshness(cursor);
}

export const FRESHNESS_LABELS: Record<Freshness, string> = {
  live: "live",
  down: "down",
  paused: "paused",
};

/** Tailwind text-color class for the freshness dot, mapped to the semantic
 *  tokens (--allow / --deny / --warn). Paused is an operational state the
 *  owner chose, not a failure — amber, like a token revoke, not deny-red. */
export const FRESHNESS_COLORS: Record<Freshness, string> = {
  live: "text-[hsl(var(--allow))]",
  down: "text-[hsl(var(--deny))]",
  paused: "text-[hsl(var(--warn))]",
};
