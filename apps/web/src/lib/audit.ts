// Server-only query helpers for the /audit dashboard. Two-layer isolation:
//
//   1. Every WHERE clause includes `customer_id = <bound id>` explicitly.
//      This is the always-on application-layer defense — every code path
//      to audit_events_index goes through this file, so the filter is
//      mechanically present on every read.
//
//   2. Every read runs inside a Postgres transaction that emits
//      `SET LOCAL app.customer_id = '<id>'`. This binds the RLS policy
//      declared in 0001_constraints.sql + 0004_force_rls. Today, the Neon
//      owner role we connect as has BYPASSRLS, so the policy is a no-op
//      at runtime. The bind is in place so that when production swaps to
//      a separate non-bypass app role (created via Neon console — Neon
//      doesn't grant project users the ALTER ROLE BYPASSRLS privilege
//      needed to do it via migration), RLS engages without an app-side
//      change. Belt + suspenders.
//
// Why sql.raw() for the SET LOCAL: Postgres rejects parameterized values
// in `SET LOCAL`. We validate customer_id matches the ULID alphabet
// before inlining; the regex below is the only entry point for that
// string. The equivalent function-form `SELECT set_config(name, value,
// true)` accepts parameters but produces a SQL log line that does not
// contain "SET LOCAL", which makes the RLS-bind audit harder for
// reviewers and tests.
//
// List shape note: the OSS engine emits ATTEMPTED → DECIDED →
// (EXECUTED | FAILED) as separate rows tied by query_id. The dashboard
// list collapses this lifecycle into one logical row per query, with a
// computed terminal status. The lifecycle stages are still individually
// queryable (getRelatedEvents) for the detail page.

import { and, asc, eq, gte, isNotNull, sql } from "drizzle-orm";

import {
  auditEventsIndex,
  getDb,
  indexerCursors,
  type AuditEvent,
  type Region,
} from "@midplane-cloud/db";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// --- audit retention window -------------------------------------------------
//
// Pricing gates how far back a customer can READ their audit log (Free 7d,
// Pro/Team 30d). This is a query-time visibility clamp, NOT storage deletion
// — old rows persist in audit_events_index; reads hide them. A storage-
// pruning job is a separate follow-up (see TODOS.md).
//
// retentionDays is OPTIONAL on every read helper: when omitted, no clamp is
// applied (preserves the pre-pricing behavior and the existing test shape).
// EVERY real caller (the /audit pages, the dashboard freshness reads) MUST
// pass caps.auditRetentionDays from resolvePlan() — a forgotten clamp is a
// privacy leak, which the audit-retention e2e is the backstop against.

/** Lower bound of the retention window as a Date, or null when no window is
 *  enforced. Used by the Drizzle-builder reads (gte()). */
export function retentionSince(
  retentionDays: number | undefined,
  now: Date = new Date(),
): Date | null {
  if (retentionDays === undefined || !Number.isFinite(retentionDays)) {
    return null;
  }
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

// --- audit time window ------------------------------------------------------
//
// The window is the user-chosen lookback the page filters to (default 24h),
// SEPARATE from retention (the plan's hard horizon). The window is always
// clamped to retention — a Free customer who picks 30d still only sees 7d.
// Every list/count/chip read combines both bounds into a single ts lower
// bound: the LATER of (now - retention) and (now - window). The chart reads
// the same window to size + bucket its bars.

export const AUDIT_WINDOWS = ["24h", "7d", "30d"] as const;
export type AuditWindowKey = (typeof AUDIT_WINDOWS)[number];

export interface AuditWindow {
  key: AuditWindowKey;
  /** Lookback in hours, after clamping to retention. */
  hours: number;
  /** Chart bucket granularity. Hourly stays legible up to ~48h; longer
   *  windows switch to daily so the sparkline isn't hundreds of slivers. */
  bucket: "hour" | "day";
  /** Number of chart buckets to render. */
  bucketCount: number;
}

const WINDOW_DEFS: Record<AuditWindowKey, AuditWindow> = {
  "24h": { key: "24h", hours: 24, bucket: "hour", bucketCount: 24 },
  "7d": { key: "7d", hours: 24 * 7, bucket: "day", bucketCount: 7 },
  "30d": { key: "30d", hours: 24 * 30, bucket: "day", bucketCount: 30 },
};

/** Coerce an arbitrary string (URL param) to a valid window key. */
export function parseAuditWindow(raw: string | undefined): AuditWindowKey {
  return (AUDIT_WINDOWS as readonly string[]).includes(raw ?? "")
    ? (raw as AuditWindowKey)
    : "24h";
}

/** Resolve the requested window, clamped to the plan retention horizon.
 *  When the request reaches past retention, hours are capped and the chart
 *  bucket count shrinks to match (so 30d on a 7d plan renders 7 daily bars,
 *  not 30 with 23 always-empty). */
export function resolveAuditWindow(
  key: AuditWindowKey | undefined,
  retentionDays: number | undefined,
): AuditWindow {
  const base = WINDOW_DEFS[key ?? "24h"] ?? WINDOW_DEFS["24h"];
  if (retentionDays === undefined || !Number.isFinite(retentionDays)) {
    return base;
  }
  const retHours = retentionDays * 24;
  if (base.hours <= retHours) return base;
  const hours = retHours;
  const bucketCount =
    base.bucket === "day"
      ? Math.max(1, Math.ceil(hours / 24))
      : Math.max(1, Math.ceil(hours));
  return { ...base, hours, bucketCount };
}

/** Combined ts lower bound (the later of the retention and window bounds)
 *  as a Date, or null when neither is set. Used by the Drizzle-builder
 *  chip-list reads. */
function lowerBoundSince(
  retentionDays: number | undefined,
  windowHours: number | undefined,
  now: Date = new Date(),
): Date | null {
  const bounds: number[] = [];
  const ret = retentionSince(retentionDays, now);
  if (ret) bounds.push(ret.getTime());
  if (windowHours !== undefined && Number.isFinite(windowHours)) {
    bounds.push(now.getTime() - windowHours * 60 * 60 * 1000);
  }
  if (bounds.length === 0) return null;
  return new Date(Math.max(...bounds));
}

/** lowerBoundSince as an ISO string for the raw-SQL reads. */
function lowerBoundIso(
  retentionDays: number | undefined,
  windowHours: number | undefined,
  now: Date,
): string | null {
  return lowerBoundSince(retentionDays, windowHours, now)?.toISOString() ?? null;
}

// Lifecycle event types — still emitted per-row by the OSS engine and
// rendered individually on the audit detail page. The list page no longer
// filters by these (it filters by terminal QueryStatus instead).
export const EVENT_TYPES = [
  "ATTEMPTED",
  "DECIDED",
  "EXECUTED",
  "FAILED",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// Terminal-state classification of a query's lifecycle. Computed from the
// set of stage rows in the DB, not stored. Order here is the order chips
// appear in the filter strip.
//
// The last three are NON-QUERY events that ride in the same list because a
// reviewer needs one place to see everything that touched the boundary:
//   - POLICY_RELOAD   — config change (the engine's POLICY_RELOADED on a
//                       hot-swap, plus the cloud's actor-stamped
//                       POLICY_CHANGED / TENANT_SCOPE_CHANGED / REGION_CHANGED)
//   - TOKEN_CREATED   — an MCP credential was minted
//   - TOKEN_REVOKED   — an MCP credential was killed (a security event)
// They carry a NULL query_id and no SQL; the status pill marks each
// distinct and the list renders an event summary in the SQL column.
export const QUERY_STATUSES = [
  "ALLOWED",
  "DENIED",
  "FAILED",
  "STUCK",
  "PENDING",
  "POLICY_RELOAD",
  "TOKEN_CREATED",
  "TOKEN_REVOKED",
] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

// Query-outcome statuses vs. non-query event statuses. The filter strip
// groups them under separate labels ("Status" vs "Events") and the list
// renderer switches on isEventStatus() to decide between SQL and an event
// summary. Keep these two arrays a partition of QUERY_STATUSES.
export const QUERY_OUTCOME_STATUSES = [
  "ALLOWED",
  "DENIED",
  "FAILED",
  "STUCK",
  "PENDING",
] as const satisfies readonly QueryStatus[];
export const EVENT_STATUSES = [
  "POLICY_RELOAD",
  "TOKEN_CREATED",
  "TOKEN_REVOKED",
] as const satisfies readonly QueryStatus[];

/** True for the non-query rows (config + credential events) that ride in
 *  the audit list. They have no query_id and no SQL. */
export function isEventStatus(status: QueryStatus): boolean {
  return (EVENT_STATUSES as readonly string[]).includes(status);
}

// A query is STUCK when it reached ATTEMPTED (or DECIDED) but no terminal
// stage (EXECUTED/FAILED/DENIED) arrived after this many milliseconds of
// wall-clock from the last seen event. Tuned around the indexer tick
// (5s) plus a couple of cycles of headroom — anything longer than this
// almost certainly means the engine crashed or a downstream Postgres
// hung, both worth surfacing.
const STUCK_THRESHOLD_MS = 30_000;

export interface AuditQueryListRow {
  /** Null for POLICY_RELOAD rows (those aren't queries — they're operator
   *  events the OSS engine emits on hot-swap). */
  queryId: string | null;
  /** ULID of the ATTEMPTED event — stable cursor token (it never moves
   *  once written). Used for pagination ordering. POLICY_RELOAD rows
   *  carry the policy event's own id here. */
  attemptedEventId: string;
  /** Most recent event id for this query. The list row links here so the
   *  detail page lands on whichever stage rendered the terminal state. */
  headEventId: string;
  startedAt: Date;
  lastTs: Date;
  tenantId: string;
  database: string;
  agentName: string | null;
  agentVersion: string | null;
  agentIntent: string | null;
  intentSource: "mcp_meta" | "sql_comment" | "http_header" | null;
  sqlRaw: string | null;
  sqlFingerprint: string | null;
  /** "allow" | "deny" | other free-text — whatever the OSS engine wrote
   *  on the DECIDED payload. Lowercased by convention. Null when no
   *  DECIDED row exists yet. */
  decision: string | null;
  decisionReason: string | null;
  execMs: number | null;
  status: QueryStatus;
  /** Full payload of the underlying non-query event — POLICY_RELOAD rows
   *  carry the engine/config payload (OSS 0.4.0+ emits `sections_changed`
   *  / `databases_changed` / `diffs` so the list renders "tenant_scope
   *  updated on main"; older rows fall back to a generic label), and
   *  TOKEN_CREATED / TOKEN_REVOKED rows carry the credential payload
   *  (token_name / prefix / last4 / reason) the list summarizes. Null on
   *  every query row. */
  policyPayload: Record<string, unknown> | null;
}

export interface ListAuditOpts {
  region: Region;
  /** Empty/undefined = all statuses. */
  statuses?: readonly QueryStatus[];
  /** Empty/undefined = all tenants. */
  tenantId?: string;
  /** Empty/undefined = all databases. The name is the OSS-side `database:`
   *  on a connection (the per-DB row in `connection_databases`), not a
   *  per-client connection. Hits audit_customer_region_database_ts_idx. */
  database?: string;
  /** Empty/undefined = all agents. Matches audit_events_index.agent_name
   *  (e.g. "claude-code"). Hits audit_customer_region_agent_ts_idx. Excludes
   *  non-query events (they carry no agent_name). */
  agentName?: string;
  /** Empty/undefined = all tokens. Matches audit_events_index.mcp_token_id
   *  — every audit row from a token's session carries it. Hits
   *  audit_customer_region_token_ts_idx. Answers "everything this credential
   *  did". Excludes config events (they carry no token id). */
  tokenId?: string;
  /** Substring match against payload->>'sql_raw',
   *  payload->>'sql_fingerprint', and query_id. Matches if ANY event for
   *  the query matches — so a search hit on the ATTEMPTED row's SQL
   *  surfaces the whole query lifecycle. */
  search?: string;
  /** ATTEMPTED-event-id of the last row from the previous page. The next
   *  page returns queries whose attempted_event_id < cursor (DESC paging). */
  cursor?: string;
  /** Page size; default 50. The query asks for limit+1 so callers can
   *  detect whether a next page exists without a second COUNT round-trip. */
  pageSize?: number;
  /** Injected for tests so STUCK detection is deterministic. */
  now?: () => Date;
  /** Plan retention window in days. When set, rows older than this are
   *  excluded. Omitted = no clamp. */
  retentionDays?: number;
  /** User-chosen lookback in hours (the time-window filter). Combined with
   *  retentionDays into a single ts lower bound. Omitted = no window clamp. */
  windowHours?: number;
}

export interface ListAuditResult {
  rows: AuditQueryListRow[];
  nextCursor: string | null;
}

/** List queries (collapsed lifecycle) for the current customer, RLS-scoped
 *  + region-pinned. */
export async function listAuditQueries(
  customerId: string,
  opts: ListAuditOpts,
): Promise<ListAuditResult> {
  const limit = opts.pageSize ?? 50;
  const nowMs = (opts.now?.() ?? new Date()).getTime();
  // ISO text + ::timestamptz cast: postgres-js's raw-unsafe parameter
  // codec (the path Drizzle uses for tx.execute on a sql template) does
  // not auto-serialize Date, so binding a Date here throws
  // "argument must be string or Buffer". Same pattern as eventVolumeByHour.
  const stuckCutoffIso = new Date(nowMs - STUCK_THRESHOLD_MS).toISOString();
  // Lower-bound clamp (retention ∧ window). Applied to the aggregation, the
  // search subquery, and the policy-events branch so an out-of-window row
  // can't surface via any path. Lifecycle rows of one query land within
  // seconds of each other, so a hours/days-wide window keeps each query
  // whole — no split lifecycles.
  const retIso = lowerBoundIso(
    opts.retentionDays,
    opts.windowHours,
    new Date(nowMs),
  );
  const retentionClause = retIso ? sql`AND ts >= ${retIso}::timestamptz` : sql``;

  return withCustomerScope(opts.region, customerId, async (tx) => {
    // Inner WHERE narrows the rows that participate in aggregation. Search
    // is applied via a query_id IN (...) subquery so a search hit on the
    // ATTEMPTED row surfaces the entire lifecycle (the inner WHERE alone
    // would filter out the DECIDED/EXECUTED rows for that query). Tenant,
    // region, and database filter directly because they're identical
    // across all rows of a query_id.
    const tenantClause = opts.tenantId
      ? sql`AND tenant_id = ${opts.tenantId}`
      : sql``;
    const databaseClause = opts.database
      ? sql`AND database = ${opts.database}`
      : sql``;
    // agent_name / mcp_token_id filter the raw rows directly (identical
    // across a query's lifecycle). Both naturally exclude the non-query
    // event rows — config events carry neither, token events carry no agent.
    const agentClause = opts.agentName
      ? sql`AND agent_name = ${opts.agentName}`
      : sql``;
    const tokenClause = opts.tokenId
      ? sql`AND mcp_token_id = ${opts.tokenId}`
      : sql``;
    const cursorClause = opts.cursor
      ? sql`AND attempted_event_id < ${opts.cursor}`
      : sql``;

    const hasSearch =
      opts.search !== undefined && opts.search.trim().length > 0;
    const searchClause = (() => {
      const needle = opts.search?.trim();
      if (!needle) return sql``;
      const pattern = `%${needle}%`;
      return sql`
        AND query_id IN (
          SELECT query_id FROM audit_events_index
          WHERE customer_id = ${customerId}
            AND region = ${opts.region}
            ${retentionClause}
            AND (
              payload ->> 'sql_raw' ILIKE ${pattern}
              OR payload ->> 'sql_fingerprint' ILIKE ${pattern}
              OR query_id ILIKE ${pattern}
            )
        )
      `;
    })();
    // Policy events have no SQL or query_id to match — exclude them
    // entirely when the user is searching, otherwise an unrelated reload
    // event would pop up in a "DELETE FROM users" search and confuse.
    const policySearchClause = hasSearch ? sql`AND FALSE` : sql``;

    const statusClause = (() => {
      if (!opts.statuses || opts.statuses.length === 0) return sql``;
      // Status is a CASE expression; can't reference an alias in HAVING
      // across all PG versions, so wrap the whole thing in a subselect.
      const list = opts.statuses.map((s) => sql`${s}`);
      return sql`AND status IN (${sql.join(list, sql`, `)})`;
    })();

    // The CASE order matters: terminal SUCCESS / FAILURE / DENY come
    // before STUCK / PENDING. has_executed implies an upstream allow
    // decision (the OSS engine never emits EXECUTED without DECIDED+allow);
    // we trust that invariant rather than re-checking.
    //
    // policy_events is unioned in alongside the query aggregation so the
    // non-query singletons (no lifecycle) keep showing up in the audit
    // log: config changes (POLICY_RELOADED + the cloud's actor-stamped
    // POLICY_CHANGED / TENANT_SCOPE_CHANGED / REGION_CHANGED) and
    // credential events (TOKEN_CREATED / TOKEN_REVOKED). Operators rely on
    // this list to verify a hot-swap landed and to see who minted/killed a
    // token. Both CTEs project the same column shape with explicit NULL
    // casts; UNION ALL needs matching types on each branch.
    const stmt = sql`
      WITH agg AS (
        SELECT
          query_id,
          MIN(id) AS attempted_event_id,
          MAX(id) AS head_event_id,
          MIN(ts) AS started_at,
          MAX(ts) AS last_ts,
          MAX(tenant_id) AS tenant_id,
          MAX(database) AS database,
          MAX(agent_name) AS agent_name,
          MAX(agent_version) AS agent_version,
          MAX(agent_intent) AS agent_intent,
          MAX(intent_source) AS intent_source,
          BOOL_OR(event_type = 'ATTEMPTED') AS has_attempted,
          BOOL_OR(event_type = 'DECIDED') AS has_decided,
          BOOL_OR(event_type = 'EXECUTED') AS has_executed,
          BOOL_OR(event_type = 'FAILED') AS has_failed,
          MAX(payload ->> 'sql_raw') FILTER (WHERE event_type = 'ATTEMPTED') AS sql_raw,
          MAX(payload ->> 'sql_fingerprint') FILTER (WHERE event_type = 'ATTEMPTED') AS sql_fingerprint,
          MAX(payload ->> 'decision') FILTER (WHERE event_type = 'DECIDED') AS decision,
          MAX(payload ->> 'reason') FILTER (WHERE event_type = 'DECIDED') AS decision_reason,
          MAX((payload ->> 'exec_ms')::numeric) FILTER (WHERE event_type = 'EXECUTED') AS exec_ms
        FROM audit_events_index
        WHERE customer_id = ${customerId}
          AND region = ${opts.region}
          AND event_type IN ('ATTEMPTED', 'DECIDED', 'EXECUTED', 'FAILED')
          ${retentionClause}
          ${tenantClause}
          ${databaseClause}
          ${agentClause}
          ${tokenClause}
          ${searchClause}
        GROUP BY query_id
      ),
      classified AS (
        SELECT
          query_id,
          attempted_event_id,
          head_event_id,
          started_at,
          last_ts,
          tenant_id,
          database,
          agent_name,
          agent_version,
          agent_intent,
          intent_source,
          sql_raw,
          sql_fingerprint,
          decision,
          decision_reason,
          exec_ms,
          NULL::jsonb AS policy_payload,
          CASE
            WHEN has_executed THEN 'ALLOWED'
            WHEN has_failed THEN 'FAILED'
            WHEN has_decided AND lower(decision) = 'deny' THEN 'DENIED'
            WHEN last_ts < ${stuckCutoffIso}::timestamptz THEN 'STUCK'
            ELSE 'PENDING'
          END AS status
        FROM agg
      ),
      policy_events AS (
        SELECT
          NULL::text AS query_id,
          id AS attempted_event_id,
          id AS head_event_id,
          ts AS started_at,
          ts AS last_ts,
          tenant_id,
          database,
          NULL::text AS agent_name,
          NULL::text AS agent_version,
          NULL::text AS agent_intent,
          NULL::text AS intent_source,
          NULL::text AS sql_raw,
          NULL::text AS sql_fingerprint,
          NULL::text AS decision,
          NULL::text AS decision_reason,
          NULL::numeric AS exec_ms,
          payload AS policy_payload,
          CASE event_type
            WHEN 'TOKEN_CREATED' THEN 'TOKEN_CREATED'
            WHEN 'TOKEN_REVOKED' THEN 'TOKEN_REVOKED'
            ELSE 'POLICY_RELOAD'
          END AS status
        FROM audit_events_index
        WHERE customer_id = ${customerId}
          AND region = ${opts.region}
          AND event_type IN ('POLICY_RELOADED', 'POLICY_CHANGED', 'TENANT_SCOPE_CHANGED', 'REGION_CHANGED', 'TOKEN_CREATED', 'TOKEN_REVOKED')
          ${retentionClause}
          ${tenantClause}
          ${databaseClause}
          ${agentClause}
          ${tokenClause}
          ${policySearchClause}
      )
      SELECT * FROM (
        SELECT * FROM classified
        UNION ALL
        SELECT * FROM policy_events
      ) merged
      WHERE 1=1
        ${cursorClause}
        ${statusClause}
      ORDER BY attempted_event_id DESC
      LIMIT ${limit + 1}
    `;

    const result = await tx.execute(stmt);
    const rawRows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
    const rows: AuditQueryListRow[] = (rawRows as Record<string, unknown>[]).map(
      (r) => ({
        queryId: r.query_id == null ? null : String(r.query_id),
        attemptedEventId: String(r.attempted_event_id),
        headEventId: String(r.head_event_id),
        startedAt: new Date(r.started_at as string | Date),
        lastTs: new Date(r.last_ts as string | Date),
        tenantId: String(r.tenant_id),
        database: String(r.database),
        agentName: (r.agent_name as string | null) ?? null,
        agentVersion: (r.agent_version as string | null) ?? null,
        agentIntent: (r.agent_intent as string | null) ?? null,
        intentSource: (r.intent_source as AuditQueryListRow["intentSource"]) ?? null,
        sqlRaw: (r.sql_raw as string | null) ?? null,
        sqlFingerprint: (r.sql_fingerprint as string | null) ?? null,
        decision: (r.decision as string | null) ?? null,
        decisionReason: (r.decision_reason as string | null) ?? null,
        execMs: r.exec_ms == null ? null : Number(r.exec_ms),
        status: r.status as QueryStatus,
        policyPayload: parsePolicyPayload(r.policy_payload),
      }),
    );

    const next =
      rows.length > limit
        ? (rows[limit - 1]?.attemptedEventId ?? null)
        : null;
    return { rows: rows.slice(0, limit), nextCursor: next };
  });
}

// Driver-side: postgres-js returns jsonb as a parsed object; some
// migration paths or replay tools surface the same column as a JSON
// string. Normalize so the renderer always sees Record<string, unknown>
// or null; anything else (array, scalar) is treated as null since none
// of the structured renderers expect those shapes.
function parsePolicyPayload(v: unknown): Record<string, unknown> | null {
  if (v == null) return null;
  if (typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return null;
}

/** Distinct tenant_ids the current customer has audit rows for, used to
 *  populate the tenant filter chip. ORDER BY before LIMIT so the visible
 *  set is deterministic when a customer has more than 50 tenants — without
 *  the sort, Postgres can return any 50 distinct names per query and chips
 *  would shuffle between requests, hiding some tenants from the UI entirely. */
export async function listTenantIds(
  customerId: string,
  region: Region,
  retentionDays?: number,
  windowHours?: number,
): Promise<string[]> {
  const since = lowerBoundSince(retentionDays, windowHours);
  return withCustomerScope(region, customerId, async (tx) => {
    const rows = await tx
      .selectDistinct({ tenantId: auditEventsIndex.tenantId })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.region, region),
          // Clamp so the filter chips don't surface tenant names whose only
          // rows are outside the retention window / selected time window.
          since ? gte(auditEventsIndex.ts, since) : undefined,
        ),
      )
      .orderBy(asc(auditEventsIndex.tenantId))
      .limit(50);
    return rows.map((r) => r.tenantId);
  });
}

/** Distinct database names for the customer in this region. The values are
 *  the OSS-side `database:` field stamped on each audit row (one row per DB
 *  attached to a connection). Same ORDER BY before LIMIT contract as
 *  listTenantIds — without it, customers with >50 DBs would see the chip
 *  set shuffle and lose the ability to pick certain databases. */
export async function listDatabases(
  customerId: string,
  region: Region,
  retentionDays?: number,
  windowHours?: number,
): Promise<string[]> {
  const since = lowerBoundSince(retentionDays, windowHours);
  return withCustomerScope(region, customerId, async (tx) => {
    const rows = await tx
      .selectDistinct({ database: auditEventsIndex.database })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.region, region),
          since ? gte(auditEventsIndex.ts, since) : undefined,
        ),
      )
      .orderBy(asc(auditEventsIndex.database))
      .limit(50);
    return rows.map((r) => r.database);
  });
}

/** Distinct agent names (audit_events_index.agent_name) the customer has
 *  rows for, for the agent filter chip. NULL agents (non-query events) are
 *  excluded. Same ORDER BY before LIMIT determinism contract as the other
 *  chip lists. Hits audit_customer_region_agent_ts_idx. */
export async function listAgents(
  customerId: string,
  region: Region,
  retentionDays?: number,
  windowHours?: number,
): Promise<string[]> {
  const since = lowerBoundSince(retentionDays, windowHours);
  return withCustomerScope(region, customerId, async (tx) => {
    const rows = await tx
      .selectDistinct({ agentName: auditEventsIndex.agentName })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.region, region),
          isNotNull(auditEventsIndex.agentName),
          since ? gte(auditEventsIndex.ts, since) : undefined,
        ),
      )
      .orderBy(asc(auditEventsIndex.agentName))
      .limit(50);
    return rows.map((r) => r.agentName).filter((n): n is string => n != null);
  });
}

export interface TokenOption {
  /** mcp_token_id — the filter value. */
  id: string;
  /** Human label for the chip: token name (· last4) when the token row is
   *  still resolvable, else a short id suffix. */
  label: string;
}

/** Tokens that appear in the customer's audit rows, for the token filter
 *  chip. The id set comes from the (already RLS-scoped) audit rows; the
 *  LEFT JOIN to mcp_tokens only enriches the label, so a deleted token
 *  still lists (falling back to a short id). */
export async function listTokenOptions(
  customerId: string,
  region: Region,
  retentionDays?: number,
  windowHours?: number,
): Promise<TokenOption[]> {
  const sinceIso = lowerBoundIso(retentionDays, windowHours, new Date());
  const windowClause = sinceIso
    ? sql`AND a.ts >= ${sinceIso}::timestamptz`
    : sql``;
  return withCustomerScope(region, customerId, async (tx) => {
    const stmt = sql`
      SELECT a.mcp_token_id AS id,
             MAX(t.name) AS name,
             MAX(t.last4) AS last4
      FROM audit_events_index a
      LEFT JOIN mcp_tokens t ON t.id = a.mcp_token_id
      WHERE a.customer_id = ${customerId}
        AND a.region = ${region}
        AND a.mcp_token_id IS NOT NULL
        ${windowClause}
      GROUP BY a.mcp_token_id
      ORDER BY MAX(t.name) ASC NULLS LAST, a.mcp_token_id ASC
      LIMIT 50
    `;
    const raw = await tx.execute(stmt);
    const rows = ((raw as unknown as { rows?: unknown[] }).rows ??
      (raw as unknown as unknown[])) as Record<string, unknown>[];
    return rows.map((r) => {
      const id = String(r.id);
      const name = typeof r.name === "string" && r.name ? r.name : null;
      const last4 = typeof r.last4 === "string" && r.last4 ? r.last4 : null;
      const label = name
        ? last4
          ? `${name} ·${last4}`
          : name
        : `token …${id.slice(-6)}`;
      return { id, label };
    });
  });
}

export const TERMINAL_STATUSES = ["executed", "denied", "failed"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface VolumeBucket {
  /** Bucket start, period-aligned UTC (top of hour, or midnight for daily). */
  ts: Date;
  /** Per-terminal-status query counts; missing keys = 0. */
  counts: Partial<Record<TerminalStatus, number>>;
}

/** Hourly query volume for the trailing `hours` window, bucketed by terminal
 *  outcome. One query (one query_id) contributes one count to one bucket —
 *  not one per lifecycle event — so the chart reads as "queries per hour"
 *  not "audit rows per hour" (which would triple-count attempted/decided/
 *  executed). Bucket time = the terminal event's ts.
 *
 *  Terminal precedence per query_id:
 *    EXECUTED          → executed   (allow → ran fine)
 *    FAILED            → failed     (allow → DB errored)
 *    DECIDED+deny      → denied     (policy blocked)
 *    everything else   → dropped    (in-flight ATTEMPTED, allow-only DECIDED
 *                                    waiting on EXECUTED/FAILED)
 *
 *  Hits audit_customer_region_ts_idx for the range scan, then audit_query_id_idx
 *  via DISTINCT ON. Within a 24h window over one customer this is small. */
export interface VolumeFilters {
  /** Empty/undefined = all tenants. */
  tenantId?: string;
  /** Empty/undefined = all databases. */
  database?: string;
  /** Empty/undefined = all agents. */
  agentName?: string;
  /** Empty/undefined = all tokens. */
  tokenId?: string;
  /** Substring against query_id, payload->>'sql_raw', or
   *  payload->>'sql_fingerprint'. Restricts which queries contribute via a
   *  query_id IN (...) subquery so the chart matches what the table below
   *  it shows. */
  search?: string;
}

export async function eventVolumeByHour(
  customerId: string,
  region: Region,
  opts: {
    /** Bucket span. `hours` (legacy) sets an hourly bucket count when
     *  bucketCount is omitted. */
    hours?: number;
    /** Bucket granularity — hourly for short windows, daily for long ones
     *  so the sparkline stays legible. Default "hour". */
    bucket?: "hour" | "day";
    /** Number of buckets to render. Default = hours ?? 24. */
    bucketCount?: number;
    now?: () => Date;
    retentionDays?: number;
  } & VolumeFilters = {},
): Promise<VolumeBucket[]> {
  const bucketUnit = opts.bucket ?? "hour";
  const stepMs = bucketUnit === "day" ? 86_400_000 : 3_600_000;
  const count = opts.bucketCount ?? opts.hours ?? 24;
  const now = (opts.now ?? (() => new Date()))();
  // Align to the top of the current period so buckets land on clean
  // boundaries (top of hour for hourly, midnight UTC for daily).
  const end = new Date(now);
  if (bucketUnit === "day") {
    end.setUTCHours(0, 0, 0, 0);
  } else {
    end.setUTCMinutes(0, 0, 0);
  }
  const since = new Date(end.getTime() - (count - 1) * stepMs);
  // Clamp the query's lower bound to the retention window when it would reach
  // further back than the plan allows. Bucket construction below still spans
  // the requested window; out-of-retention buckets simply render empty.
  const retSince = retentionSince(opts.retentionDays, now);
  const queryStart =
    retSince && retSince.getTime() > since.getTime() ? retSince : since;
  // date_trunc unit comes from a strict allowlist above — safe to inline.
  const truncExpr = sql.raw(`date_trunc('${bucketUnit}', ts)`);

  // Boundary is sent as ISO text + cast to timestamptz on the server side.
  // postgres-js's raw-unsafe parameter path (used by Drizzle for tx.execute
  // on a sql template) does not auto-serialize Date — passing a Date directly
  // throws "argument must be string or Buffer". String + ::timestamptz is
  // the same wire format the tagged-template path produces.
  const sinceIso = queryStart.toISOString();

  // Filter fragments composed onto the inner query so the chart honors
  // exactly the same chips the audit table does. Without this, filtering
  // to a quiet tenant/db can leave a non-zero chart above an empty table,
  // which reads as a broken filter.
  const tenantClause = opts.tenantId
    ? sql`AND tenant_id = ${opts.tenantId}`
    : sql``;
  const databaseClause = opts.database
    ? sql`AND database = ${opts.database}`
    : sql``;
  const agentClause = opts.agentName
    ? sql`AND agent_name = ${opts.agentName}`
    : sql``;
  const tokenClause = opts.tokenId
    ? sql`AND mcp_token_id = ${opts.tokenId}`
    : sql``;
  const searchClause =
    opts.search && opts.search.trim().length > 0
      ? (() => {
          const needle = `%${opts.search.trim()}%`;
          // Mirror listAuditQueries' search shape (sql_raw + sql_fingerprint
          // + query_id) so the chart and the table can never disagree on
          // which queries are in scope.
          return sql`AND query_id IN (
            SELECT DISTINCT query_id FROM audit_events_index
            WHERE customer_id = ${customerId}
              AND region = ${region}
              AND ts >= ${sinceIso}::timestamptz
              AND (
                query_id ILIKE ${needle}
                OR payload ->> 'sql_raw' ILIKE ${needle}
                OR payload ->> 'sql_fingerprint' ILIKE ${needle}
              )
          )`;
        })()
      : sql``;

  const rows = await withCustomerScope(region, customerId, async (tx) => {
    // DISTINCT ON (query_id) keeps the row with the lowest precedence_rank
    // per query, which is the terminal event we want to bucket on.
    // Allow-only DECIDED rows are filtered out in the WHERE so they don't
    // shadow the matching EXECUTED/FAILED row for the same query.
    const rankedSql = sql<{
      bucket: Date;
      terminal: string;
      count: number;
    }>`
      SELECT
        ${truncExpr} AS bucket,
        terminal,
        count(*)::int AS count
      FROM (
        SELECT DISTINCT ON (query_id)
          query_id,
          ts,
          CASE event_type
            WHEN 'EXECUTED' THEN 'executed'
            WHEN 'FAILED' THEN 'failed'
            ELSE 'denied'
          END AS terminal
        FROM audit_events_index
        WHERE customer_id = ${customerId}
          AND region = ${region}
          AND ts >= ${sinceIso}::timestamptz
          AND (
            event_type IN ('EXECUTED', 'FAILED')
            OR (event_type = 'DECIDED' AND lower(payload ->> 'decision') = 'deny')
          )
          ${tenantClause}
          ${databaseClause}
          ${agentClause}
          ${tokenClause}
          ${searchClause}
        ORDER BY
          query_id,
          CASE event_type
            WHEN 'EXECUTED' THEN 1
            WHEN 'FAILED' THEN 2
            WHEN 'DECIDED' THEN 3
          END
      ) AS terminals
      GROUP BY 1, 2
    `;
    const result = await tx.execute(rankedSql);
    return result as unknown as Array<{
      bucket: Date | string;
      terminal: string;
      count: number;
    }>;
  });

  const buckets: VolumeBucket[] = [];
  const byKey = new Map<number, VolumeBucket>();
  for (let i = 0; i < count; i++) {
    const ts = new Date(since.getTime() + i * stepMs);
    const b: VolumeBucket = { ts, counts: {} };
    buckets.push(b);
    byKey.set(ts.getTime(), b);
  }
  for (const r of rows) {
    const key = new Date(r.bucket).getTime();
    const b = byKey.get(key);
    if (!b) continue;
    if ((TERMINAL_STATUSES as readonly string[]).includes(r.terminal)) {
      b.counts[r.terminal as TerminalStatus] = Number(r.count);
    }
  }
  return buckets;
}

/** Counts per terminal status, used to render the badges next to each
 *  filter chip. Computed by re-running the same aggregation as
 *  listAuditQueries, but grouped by status. RLS-scoped + region-pinned. */
export async function countByStatus(
  customerId: string,
  region: Region,
  now: () => Date = () => new Date(),
  retentionDays?: number,
  windowHours?: number,
): Promise<Record<QueryStatus, number>> {
  const result: Record<QueryStatus, number> = {
    ALLOWED: 0,
    DENIED: 0,
    FAILED: 0,
    STUCK: 0,
    PENDING: 0,
    POLICY_RELOAD: 0,
    TOKEN_CREATED: 0,
    TOKEN_REVOKED: 0,
  };
  // ISO text + ::timestamptz cast: see listAuditQueries above for the
  // postgres-js raw-unsafe Date-codec rationale. Same fix applies here.
  const nowDate = now();
  const stuckCutoffIso = new Date(
    nowDate.getTime() - STUCK_THRESHOLD_MS,
  ).toISOString();
  // Lower-bound clamp (retention ∧ window), applied to both the query
  // aggregation and the event count so the badge totals match what the list
  // actually shows for the selected window.
  const retIso = lowerBoundIso(retentionDays, windowHours, nowDate);
  const retentionClause = retIso ? sql`AND ts >= ${retIso}::timestamptz` : sql``;
  return withCustomerScope(region, customerId, async (tx) => {
    // Single statement: query lifecycles classified by status, plus a
    // POLICY_RELOAD bucket so operators can see at a glance how many
    // hot-swaps landed in the visible window.
    const stmt = sql`
      WITH agg AS (
        SELECT
          query_id,
          MAX(ts) AS last_ts,
          BOOL_OR(event_type = 'EXECUTED') AS has_executed,
          BOOL_OR(event_type = 'FAILED') AS has_failed,
          BOOL_OR(event_type = 'DECIDED') AS has_decided,
          MAX(payload ->> 'decision') FILTER (WHERE event_type = 'DECIDED') AS decision
        FROM audit_events_index
        WHERE customer_id = ${customerId}
          AND region = ${region}
          AND event_type IN ('ATTEMPTED', 'DECIDED', 'EXECUTED', 'FAILED')
          ${retentionClause}
        GROUP BY query_id
      )
      SELECT
        CASE
          WHEN has_executed THEN 'ALLOWED'
          WHEN has_failed THEN 'FAILED'
          WHEN has_decided AND lower(decision) = 'deny' THEN 'DENIED'
          WHEN last_ts < ${stuckCutoffIso}::timestamptz THEN 'STUCK'
          ELSE 'PENDING'
        END AS status,
        count(*)::int AS count
      FROM agg
      GROUP BY 1
      UNION ALL
      SELECT
        CASE event_type
          WHEN 'TOKEN_CREATED' THEN 'TOKEN_CREATED'
          WHEN 'TOKEN_REVOKED' THEN 'TOKEN_REVOKED'
          ELSE 'POLICY_RELOAD'
        END AS status,
        count(*)::int AS count
      FROM audit_events_index
      WHERE customer_id = ${customerId}
        AND region = ${region}
        AND event_type IN ('POLICY_RELOADED', 'POLICY_CHANGED', 'TENANT_SCOPE_CHANGED', 'REGION_CHANGED', 'TOKEN_CREATED', 'TOKEN_REVOKED')
        ${retentionClause}
      GROUP BY 1
    `;
    const raw = await tx.execute(stmt);
    const rows = ((raw as unknown as { rows?: unknown[] }).rows ??
      (raw as unknown as unknown[])) as Record<string, unknown>[];
    for (const r of rows) {
      const status = String(r.status) as QueryStatus;
      if ((QUERY_STATUSES as readonly string[]).includes(status)) {
        result[status] = Number(r.count);
      }
    }
    return result;
  });
}

/** Single audit row by id. Returns null if RLS hid it OR it doesn't exist;
 *  the caller renders the same "no longer exists or outside retention"
 *  empty state for either, by design — we never disclose existence. */
export async function getAuditEvent(
  region: Region,
  customerId: string,
  id: string,
  retentionDays?: number,
): Promise<AuditEvent | null> {
  const since = retentionSince(retentionDays);
  return withCustomerScope(region, customerId, async (tx) => {
    const rows = await tx
      .select()
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.id, id),
          // Clamp the single-row read so a deep link to an out-of-window
          // event returns null — the detail page then renders its "no longer
          // exists or is outside your retention window" empty state.
          // getRelatedEvents (below) is intentionally NOT clamped: it's only
          // reached after this returns a non-null in-window event, and it
          // must return the FULL lifecycle (anchor-aware, codex #7).
          since ? gte(auditEventsIndex.ts, since) : undefined,
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/** All rows for the same query_id, ascending by ts. The OSS engine emits
 *  ATTEMPTED → DECIDED → (EXECUTED | FAILED) per query, so this groups the
 *  full lifecycle of one agent call into the detail page. */
export async function getRelatedEvents(
  region: Region,
  customerId: string,
  queryId: string,
): Promise<AuditEvent[]> {
  return withCustomerScope(region, customerId, async (tx) => {
    return tx
      .select()
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.queryId, queryId),
        ),
      )
      .orderBy(auditEventsIndex.ts);
  });
}

export interface StalenessRead {
  /** Most recent indexer tick for the customer's region, across all of the
   *  customer's connections. Null when the customer has no cursor rows yet
   *  (no traffic ever, OR connections deleted before the indexer first
   *  drained). The banner copy treats "no rows" as "live" — we show the
   *  amber banner only when we have evidence the indexer is behind. */
  lastIndexedAt: Date | null;
  /** Milliseconds since lastIndexedAt at the time of the read. Computed
   *  here so the page renders deterministically (server time, not browser
   *  time) and so the banner state is decided once. */
  staleMs: number | null;
}

/** Read the staleness signal for the customer's region. Uses MAX over the
 *  customer's cursor rows in that region — surfaces "indexer paused for ME"
 *  not "indexer paused for someone else". indexer_cursors does not have
 *  RLS (it's an internal pipeline table), so we filter in the WHERE. */
export async function readStaleness(
  customerId: string,
  region: Region,
  now: () => Date = () => new Date(),
): Promise<StalenessRead> {
  if (!ULID_RE.test(customerId)) {
    throw new Error("customer_id must be a ULID");
  }
  const db = getDb(region);
  const rows = await db
    .select({
      lastIndexedAt: sql<
        Date | null
      >`max(${indexerCursors.lastIndexedAt})`,
    })
    .from(indexerCursors)
    .where(
      and(
        eq(indexerCursors.customerId, customerId),
        eq(indexerCursors.region, region),
      ),
    );
  const lastIndexedAt = rows[0]?.lastIndexedAt ?? null;
  const staleMs = lastIndexedAt
    ? Math.max(0, now().getTime() - new Date(lastIndexedAt).getTime())
    : null;
  return { lastIndexedAt, staleMs };
}

// --- internals --------------------------------------------------------------

type Tx = Parameters<
  Parameters<ReturnType<typeof getDb>["transaction"]>[0]
>[0];

async function withCustomerScope<T>(
  region: Region,
  customerId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!ULID_RE.test(customerId)) {
    throw new Error("customer_id must be a ULID");
  }
  const db = getDb(region);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`SET LOCAL app.customer_id = '${customerId}'`),
    );
    return fn(tx);
  });
}
