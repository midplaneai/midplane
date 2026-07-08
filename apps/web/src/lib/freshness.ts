// Two orthogonal health axes for a project. Keep them separate — conflating
// them is what made a healthy project read a scary "Down" (see the serving
// axis note below).
//
//   Axis 1 — SERVING READINESS ("Hosted MCP server" headline dot).
//     Answers the only question the headline should answer: will this
//     project serve an MCP query? ready / paused / broken. This is what
//     every headline dot renders.
//
//   Axis 2 — AUDIT-LOG DRAIN HEALTH (secondary, demoted).
//     Whether the audit indexer is keeping the cloud audit log current for
//     this project. live / down, from indexer_cursors. A drain error here
//     does NOT stop queries from being served, so it must not turn the
//     headline red — it belongs on a secondary "audit log" line, not the
//     top-line status.
//
// ============================================================================
// Axis 1 — Serving readiness
// ============================================================================
// The engine is spawn-on-demand: it cold-starts on the next query and
// idle-stops after ~30 min. So "ready" means "will serve on demand" — NOT
// "a container is running this instant". A project with a database, not
// paused, is ready even while its engine sits idle-stopped, and even while
// its audit indexer is erroring.

export type ServingState = "ready" | "paused" | "broken";

// Why a project can't serve. Extensible: as we surface more serving-path
// faults (invalid stored policy, expired KMS credentials) they become new
// reasons. Today the one cheap, per-project, always-loaded signal is
// "no database connected" — a project with zero child databases has nothing
// for the engine to bind, so every query 404s.
export type ServingReason = "no_database";

export interface ServingInput {
  /** Owner kill switch. Non-null → queries return 403 project_paused. */
  pausedAt: Date | null;
  /** Count of child databases on the project. Every dashboard/rail payload
   *  lists ALL databases (from project_databases, not just those with audit
   *  activity), so 0 reliably means "no database connected", not "no query
   *  yet". */
  databaseCount: number;
}

export interface Serving {
  state: ServingState;
  /** Populated only when state === "broken"; null otherwise. */
  reason: ServingReason | null;
}

/** Resolve the headline serving state. Paused wins over broken: even a
 *  misconfigured project reads "paused" when the owner flipped the kill
 *  switch, so Resume is the unambiguous next step. This is the single source
 *  of truth so every headline (rail, dashboard pill, db-row dot) stays in
 *  lockstep instead of each re-deriving it. */
export function resolveServing({
  pausedAt,
  databaseCount,
}: ServingInput): Serving {
  if (pausedAt != null) return { state: "paused", reason: null };
  if (databaseCount === 0) return { state: "broken", reason: "no_database" };
  return { state: "ready", reason: null };
}

export const SERVING_LABELS: Record<ServingState, string> = {
  ready: "Ready",
  paused: "Paused",
  broken: "Action needed",
};

export const SERVING_REASON_LABELS: Record<ServingReason, string> = {
  no_database: "No database connected",
};

/** Tailwind text-color class for the serving dot, mapped to the semantic
 *  tokens. ready → --allow (green), paused → --warn (amber — an owner choice,
 *  not a fault, like a token revoke), broken → --deny (red). */
export const SERVING_COLORS: Record<ServingState, string> = {
  ready: "text-[hsl(var(--allow))]",
  paused: "text-[hsl(var(--warn))]",
  broken: "text-[hsl(var(--deny))]",
};

// ============================================================================
// Axis 2 — Audit-log drain health (secondary line; not the headline)
// ============================================================================
// Inputs are the per-project slice of indexer_cursors:
//   - "live" → indexer has not reported a fresh error. Includes
//              "awaiting first query" — the project is ready, the agent just
//              hasn't called yet.
//   - "down" → indexer reports an error newer than its last successful drain
//              (or has never drained at all).
//
// "paused" is a project-level override kept here for the secondary line's
// pause awareness; computeFreshness itself never returns it.
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

/** Three-way audit-drain health for the secondary "Audit log" line in the
 *  status popover — a richer read of the same cursor than the live/down dot.
 *  "current" (synced, or a fresh error still inside the grace window) /
 *  "error" (delayed — the drain has been failing long enough to genuinely fall
 *  behind) / "idle" (never drained — no agent has queried yet). Pause-
 *  independent: a paused project's audit line still reflects its history. */
export type AuditHealth = "current" | "error" | "idle";

/** How long the audit log may be behind before we surface "delayed". A brief
 *  blip — an engine restart, a momentary unreachable — self-heals within a
 *  tick or two, so a fresh error whose last SUCCESSFUL drain was recent is
 *  noise, not something to flag. The indexer re-stamps lastErrorAt to ~now on
 *  every failed poll (see recordError's throttle), so "time since last error"
 *  is useless for this — "time since last success" is the honest measure. */
export const AUDIT_DELAY_GRACE_MS = 10 * 60_000;

export function resolveAuditHealth(
  { lastIndexedAt, lastErrorAt }: FreshnessInput,
  now: Date = new Date(),
): AuditHealth {
  const inError =
    lastErrorAt != null && (!lastIndexedAt || lastErrorAt > lastIndexedAt);
  if (inError && lastIndexedAt) {
    // In error, but ride out a transient one: only "delayed" once the last
    // good drain is older than the grace window.
    const behindMs = now.getTime() - lastIndexedAt.getTime();
    return behindMs >= AUDIT_DELAY_GRACE_MS ? "error" : "current";
  }
  // Never drained → "no activity yet" is the honest, calm read even if the
  // first drains are erroring: there's no audit data to be behind on, and the
  // operator-facing error detail still lives in lastError / the logs. We also
  // can't measure "for a while" here (no successful drain to date from).
  if (!lastIndexedAt) return "idle";
  return "current";
}

export const AUDIT_HEALTH_LABELS: Record<AuditHealth, string> = {
  current: "Audit log up to date",
  // "delayed", not "error": the drain failed, but it's a lag in the audit
  // *record*, not a fault the user caused or a block on their queries. It
  // usually self-heals on the next successful drain.
  error: "Audit log delayed",
  idle: "No audit activity yet",
};

/** Colors for the small audit-line dot. Deliberately NOT --deny (red): a
 *  drain lag is a degraded secondary signal, not a query denial, so red would
 *  massively over-signal. "current" green, "error" amber (--warn, a calm
 *  heads-up), "idle" a muted foreground (a not-yet, not a fault). */
export const AUDIT_HEALTH_COLORS: Record<AuditHealth, string> = {
  current: "text-[hsl(var(--allow))]",
  error: "text-[hsl(var(--warn))]",
  idle: "text-subtle",
};
