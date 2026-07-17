// Connect-pane live confirmation (support-channels-onboarding Day 2).
//
// The onboarding funnel used to go dark after the DSN form: nothing in the
// app confirmed that an agent actually connected or that its first query
// arrived. This module computes the DB-backed facts the Connect pane polls
// (via /api/projects/[id]/connect-status) to close that loop:
//
//   waiting                 — no agent yet; the user is still wiring their client
//   connected               — an agent can reach the project (OAuth grant rows,
//                             or a machine token that has been used), no query yet
//   connected_no_databases  — an OAuth agent was approved with ZERO databases
//                             (granted: 0 is a real consent outcome — the proxy
//                             403s and no query ever reaches the engine or the
//                             audit index), so waiting for a query would spin
//                             forever; the user must re-consent and grant one
//   first_query             — terminal: the first query's decision landed in the
//                             audit index. Decision-aware: a denied first query
//                             is the product working, not a failure, and the UI
//                             must not mislabel it "allowed".
//
// "Agent connected" reads the same facts the consent action writes (the
// mcp_scope_grants rows + the kind='oauth' attribution row, now minted at
// consent time — see ensureConsentAttributionToken in lib/tokens.ts), so the
// confirmation lands within one poll (~5s) of the consent screen. The
// first-query fact reads audit_events_index, which lags by the indexer's 5s
// tick — worst case ~10s end-to-end, by design. PostHog events stay
// emit-only; they are never the read path here.

import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import {
  auditEventsIndex,
  getDb,
  mcpScopeGrants,
  mcpTokens,
  projectDatabases,
  projects,
  type Customer,
} from "@midplane-cloud/db";

import { EVENT_TYPES } from "./audit.ts";

export type ConnectPhase =
  | "waiting"
  | "connected"
  | "connected_no_databases"
  | "first_query";

export type FirstQueryDecision = "allow" | "deny";

export interface ConnectStatus {
  phase: ConnectPhase;
  /** Distinct databases of this project granted to OAuth agents. */
  grantedDatabases: number;
  /** Set only when phase === "first_query". */
  firstQuery: { decision: FirstQueryDecision; at: Date } | null;
}

/** Wire shape for the poll route + the client component's initial prop. */
export interface SerializedConnectStatus {
  phase: ConnectPhase;
  grantedDatabases: number;
  firstQuery: { decision: FirstQueryDecision; at: string } | null;
}

export function serializeConnectStatus(
  status: ConnectStatus,
): SerializedConnectStatus {
  return {
    phase: status.phase,
    grantedDatabases: status.grantedDatabases,
    firstQuery: status.firstQuery
      ? {
          decision: status.firstQuery.decision,
          at: status.firstQuery.at.toISOString(),
        }
      : null,
  };
}

/** Aggregated lifecycle of one query, as read from audit_events_index. */
export interface FirstQueryAgg {
  hasExecuted: boolean;
  hasMaskingBlock: boolean;
  /** payload->>'decision' of the DECIDED row; null when none indexed yet. */
  decision: string | null;
}

/** Map a query's lifecycle rows to the decision the pane branches on.
 *  Mirrors the audit list's CASE (lib/audit.ts): EXECUTED implies an
 *  upstream allow; a pre-exec column-masking rejection is a deliberate
 *  policy refusal (DENIED), not an execution error; otherwise trust the
 *  DECIDED row. Null = no decision indexed yet (in-flight — the caller
 *  keeps polling; the DECIDED row lands on the next indexer tick). */
export function classifyFirstQueryDecision(
  agg: FirstQueryAgg,
): FirstQueryDecision | null {
  if (agg.hasExecuted) return "allow";
  if (agg.hasMaskingBlock) return "deny";
  const decision = agg.decision?.toLowerCase() ?? null;
  if (decision === "deny") return "deny";
  if (decision === "allow") return "allow";
  return null;
}

/** The raw facts deriveConnectStatus folds into a phase. Split from the DB
 *  read so the state machine is unit-testable without a database. */
export interface ConnectFacts {
  /** An active kind='oauth' attribution row exists on this project. */
  oauthAgentPresent: boolean;
  /** Distinct project databases granted to LIVE OAuth agents. The read layer
   *  excludes grants whose client has a REVOKED attribution row on this
   *  project (grant rows outlive a revocation), while grants with no
   *  attribution row at all still count — consents that predate the
   *  consent-time mint only get their row at first proxy use. */
  grantedDatabases: number;
  /** A usable machine token on this project has been used at least once
   *  (last_used_at stamped by the proxy) — proof an agent reached us even
   *  without an OAuth grant. */
  urlTokenUsed: boolean;
  /** Earliest decided query in the audit index for this project, with its
   *  decision (null decision = attempted but not yet decided/indexed). */
  firstQuery: { decision: FirstQueryDecision | null; at: Date } | null;
}

export function deriveConnectStatus(facts: ConnectFacts): ConnectStatus {
  const { oauthAgentPresent, grantedDatabases, urlTokenUsed, firstQuery } =
    facts;
  // Terminal: the first query has a decision. Ordered first — a query in the
  // audit index outranks every connection-side signal.
  if (firstQuery?.decision) {
    return {
      phase: "first_query",
      grantedDatabases,
      firstQuery: { decision: firstQuery.decision, at: firstQuery.at },
    };
  }
  // A query without a decision yet still proves an agent is connected (the
  // decision follows on the next indexer tick).
  if (grantedDatabases > 0 || urlTokenUsed || firstQuery !== null) {
    return { phase: "connected", grantedDatabases, firstQuery: null };
  }
  // Approved client, zero databases: nothing can ever query, so "waiting"
  // would spin forever. Surface the fix instead.
  if (oauthAgentPresent) {
    return {
      phase: "connected_no_databases",
      grantedDatabases: 0,
      firstQuery: null,
    };
  }
  return { phase: "waiting", grantedDatabases: 0, firstQuery: null };
}

// audit_events_index carries FORCE ROW LEVEL SECURITY keyed on
// app.customer_id (RLS is enforced even for the table owner), so audit reads
// must bind the customer id per-transaction like every lib/audit.ts read does
// (withCustomerScope). The ULID check guards the sql.raw inlining — SET LOCAL
// rejects parameterized values.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** Compute the Connect pane's live status for one project. Returns null when
 *  the project is unknown or foreign (same leakage-avoidance shape as the
 *  other project reads). Member-safe: no credentials, no policy — a phase
 *  enum, a grant count, and a first-query decision.
 *
 *  All facts are fetched in ONE parallel wave, ownership included — this runs
 *  on a ~4s poll, so round-trip count matters. On an ownership miss the fact
 *  results are discarded unread: the token/grant probes are project-scoped
 *  point reads (not customer-scoped — ownership is what gates them) and the
 *  audit reads are customer+RLS-scoped, so nothing crosses a tenant boundary
 *  in what's returned; the wasted work on foreign ids is bounded by the
 *  route's per-customer rate limit. */
export async function getConnectStatus(
  customer: Customer,
  projectId: string,
): Promise<ConnectStatus | null> {
  if (!ULID_RE.test(customer.id)) {
    throw new Error("customer.id must be a ULID");
  }
  const db = getDb(customer.region);

  const [owned, oauthRows, grantRows, urlRows, firstQuery] = await Promise.all([
    db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.id, projectId), eq(projects.customerId, customer.id)),
      )
      .limit(1),
    // Active OAuth attribution row — minted at consent (including a
    // zero-database grant) and lazily at first proxy use for pre-existing
    // agents. Revoked rows don't count: a revoked agent isn't "connected".
    db
      .select({ id: mcpTokens.id })
      .from(mcpTokens)
      .where(
        and(
          eq(mcpTokens.projectId, projectId),
          eq(mcpTokens.kind, "oauth"),
          eq(mcpTokens.status, "active"),
        ),
      )
      .limit(1),
    // OAuth grant rows scoped to THIS project's databases (the same rows the
    // consent picker writes and the proxy enforces). Grants whose client has
    // a REVOKED attribution row here are residue (grant rows outlive a
    // revocation) and must not count — otherwise a revoked sibling's grants
    // read as "N databases granted" next to an active zero-grant agent.
    // Clients with NO row at all still count (pre-consent-mint consents).
    // mcp_token grants (PAT scoping) deliberately excluded — the url-token
    // signal below covers them.
    db
      .select({
        count: sql<number>`count(distinct ${mcpScopeGrants.projectDatabaseId})::int`,
      })
      .from(mcpScopeGrants)
      .innerJoin(
        projectDatabases,
        eq(projectDatabases.id, mcpScopeGrants.projectDatabaseId),
      )
      .where(
        and(
          eq(projectDatabases.projectId, projectId),
          isNotNull(mcpScopeGrants.clientId),
          sql`NOT EXISTS (
            SELECT 1 FROM mcp_tokens mt
            WHERE mt.project_id = ${projectId}
              AND mt.kind = 'oauth'
              AND mt.status = 'revoked'
              AND mt.client_id = ${mcpScopeGrants.clientId}
          )`,
        ),
      ),
    // A usable machine token that has actually been used. "Usable" matches
    // the runtime resolver (active + not expired); last_used_at is the
    // proxy's proof of contact — a minted-but-never-used token isn't a
    // connected agent.
    db
      .select({ id: mcpTokens.id })
      .from(mcpTokens)
      .where(
        and(
          eq(mcpTokens.projectId, projectId),
          eq(mcpTokens.kind, "url"),
          eq(mcpTokens.status, "active"),
          sql`(${mcpTokens.expiresAt} IS NULL OR ${mcpTokens.expiresAt} > NOW())`,
          isNotNull(mcpTokens.lastUsedAt),
        ),
      )
      .limit(1),
    // Both audit reads share one transaction so the RLS bind (SET LOCAL
    // app.customer_id) covers them — audit_events_index FORCEs row-level
    // security, and an unbound read would return zero rows on any deployment
    // whose app role isn't BYPASSRLS (e.g. self-host), leaving the pane stuck
    // before first_query forever.
    db.transaction(async (tx): Promise<ConnectFacts["firstQuery"]> => {
      await tx.execute(
        sql.raw(`SET LOCAL app.customer_id = '${customer.id}'`),
      );
      // Two probes, both scoped to the OSS per-query events only (same
      // filter as lastQueryByDatabase in lib/projects.ts — config/token
      // events ride in the same table and must not read as a query; the
      // partial audit_customer_region_project_ts_idx covers the scans):
      //
      //   1. ANY lifecycle row — proof an agent's query reached the engine
      //      (drives "connected" while the decision is still indexing).
      //   2. The earliest DECISION-BEARING row (DECIDED/EXECUTED/FAILED).
      //      The terminal state keys on this, NOT on the earliest query —
      //      a first-ever query that goes STUCK (ATTEMPTED with no terminal
      //      row: engine crash, indexer partial write) must not wedge the
      //      pane on "waiting for its first query" forever while later
      //      queries decide fine.
      const firstRows = await tx
        .select({ ts: auditEventsIndex.ts })
        .from(auditEventsIndex)
        .where(
          and(
            eq(auditEventsIndex.customerId, customer.id),
            eq(auditEventsIndex.region, customer.region),
            eq(auditEventsIndex.projectId, projectId),
            inArray(auditEventsIndex.eventType, [...EVENT_TYPES]),
          ),
        )
        .orderBy(asc(auditEventsIndex.ts), asc(auditEventsIndex.id))
        .limit(1);
      const first = firstRows[0];
      if (!first) return null;
      const decidedRows = await tx
        .select({ queryId: auditEventsIndex.queryId, ts: auditEventsIndex.ts })
        .from(auditEventsIndex)
        .where(
          and(
            eq(auditEventsIndex.customerId, customer.id),
            eq(auditEventsIndex.region, customer.region),
            eq(auditEventsIndex.projectId, projectId),
            inArray(auditEventsIndex.eventType, [
              "DECIDED",
              "EXECUTED",
              "FAILED",
            ]),
          ),
        )
        .orderBy(asc(auditEventsIndex.ts), asc(auditEventsIndex.id))
        .limit(1);
      const decided = decidedRows[0];
      // TIMESTAMPTZ may come back as a string on some drivers — coerce
      // defensively (same posture as lastQueryByDatabase), and guard
      // validity: an unparseable ts must degrade to a sentinel, not throw
      // RangeError out of serializeConnectStatus and 500 the poll route.
      const coerce = (ts: Date | string): Date => {
        const d = ts instanceof Date ? ts : new Date(ts);
        return Number.isFinite(d.getTime()) ? d : new Date(0);
      };
      if (!decided) return { decision: null, at: coerce(first.ts) };
      // Aggregate the decision-bearing query's lifecycle rows. Keyed on
      // query_id (audit_query_id_idx); customer/region re-checked so a
      // colliding query_id from another tenant can't leak into the
      // aggregate.
      const aggRows = await tx
        .select({
          hasExecuted: sql<boolean>`BOOL_OR(${auditEventsIndex.eventType} = 'EXECUTED')`,
          hasMaskingBlock: sql<boolean>`BOOL_OR(${auditEventsIndex.eventType} = 'FAILED' AND ${auditEventsIndex.payload} ->> 'error_class' = 'column_masking')`,
          decision: sql<
            string | null
          >`MAX(${auditEventsIndex.payload} ->> 'decision') FILTER (WHERE ${auditEventsIndex.eventType} = 'DECIDED')`,
        })
        .from(auditEventsIndex)
        .where(
          and(
            eq(auditEventsIndex.customerId, customer.id),
            eq(auditEventsIndex.region, customer.region),
            eq(auditEventsIndex.queryId, decided.queryId),
            inArray(auditEventsIndex.eventType, [...EVENT_TYPES]),
          ),
        );
      const agg = aggRows[0];
      return {
        decision: agg
          ? classifyFirstQueryDecision({
              hasExecuted: Boolean(agg.hasExecuted),
              hasMaskingBlock: Boolean(agg.hasMaskingBlock),
              decision: agg.decision ?? null,
            })
          : null,
        at: coerce(decided.ts),
      };
    }),
  ]);
  if (owned.length === 0) return null;

  return deriveConnectStatus({
    oauthAgentPresent: oauthRows.length > 0,
    grantedDatabases: Number(grantRows[0]?.count ?? 0),
    urlTokenUsed: urlRows.length > 0,
    firstQuery,
  });
}
