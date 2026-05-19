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

import { and, asc, eq, sql } from "drizzle-orm";

import {
  auditEventsIndex,
  getDb,
  indexerCursors,
  type AuditEvent,
  type Region,
} from "@midplane-cloud/db";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

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
// POLICY_RELOAD is a non-query event (the OSS engine emits POLICY_RELOADED
// rows on a successful /admin/policy hot-swap). It rides in the same list
// because operators need a single place to verify when a policy change
// took effect. It always carries a NULL query_id and shows alongside the
// query rows; the status pill marks it visually distinct.
export const QUERY_STATUSES = [
  "ALLOWED",
  "DENIED",
  "FAILED",
  "STUCK",
  "PENDING",
  "POLICY_RELOAD",
] as const;
export type QueryStatus = (typeof QUERY_STATUSES)[number];

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
  /** Full payload of the underlying POLICY_RELOADED event for
   *  POLICY_RELOAD list rows. Null on every query row. OSS 0.4.0 emits
   *  `sections_changed` / `databases_changed` / `diffs` here so the list
   *  view can render "tenant_scope updated on main" instead of a bare
   *  pill; older rows (pre-0.4.0) still resolve to a generic label via
   *  policyReloadSummary's fallback. */
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

  return withCustomerScope(customerId, async (tx) => {
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
    // policy_events is unioned in alongside the query aggregation so
    // POLICY_RELOADED rows (singletons, no lifecycle) keep showing up in
    // the audit log — operators rely on this list to verify a hot-swap
    // landed. Both CTEs project the same column shape with explicit
    // NULL casts; UNION ALL needs matching types on each branch.
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
          ${tenantClause}
          ${databaseClause}
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
          'POLICY_RELOAD' AS status
        FROM audit_events_index
        WHERE customer_id = ${customerId}
          AND region = ${opts.region}
          AND event_type IN ('POLICY_RELOADED', 'POLICY_CHANGED', 'TENANT_SCOPE_CHANGED')
          ${tenantClause}
          ${databaseClause}
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
): Promise<string[]> {
  return withCustomerScope(customerId, async (tx) => {
    const rows = await tx
      .selectDistinct({ tenantId: auditEventsIndex.tenantId })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.region, region),
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
): Promise<string[]> {
  return withCustomerScope(customerId, async (tx) => {
    const rows = await tx
      .selectDistinct({ database: auditEventsIndex.database })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.region, region),
        ),
      )
      .orderBy(asc(auditEventsIndex.database))
      .limit(50);
    return rows.map((r) => r.database);
  });
}

export const TERMINAL_STATUSES = ["executed", "denied", "failed"] as const;
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface VolumeBucket {
  /** Bucket start, hour-aligned UTC. */
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
  /** Substring against query_id, payload->>'sql_raw', or
   *  payload->>'sql_fingerprint'. Restricts which queries contribute via a
   *  query_id IN (...) subquery so the chart matches what the table below
   *  it shows. */
  search?: string;
}

export async function eventVolumeByHour(
  customerId: string,
  region: Region,
  opts: { hours?: number; now?: () => Date } & VolumeFilters = {},
): Promise<VolumeBucket[]> {
  const hours = opts.hours ?? 24;
  const now = (opts.now ?? (() => new Date()))();
  // Align to the top of the current hour so buckets land on clean boundaries.
  const endHour = new Date(now);
  endHour.setUTCMinutes(0, 0, 0);
  const since = new Date(endHour.getTime() - (hours - 1) * 3_600_000);

  // Boundary is sent as ISO text + cast to timestamptz on the server side.
  // postgres-js's raw-unsafe parameter path (used by Drizzle for tx.execute
  // on a sql template) does not auto-serialize Date — passing a Date directly
  // throws "argument must be string or Buffer". String + ::timestamptz is
  // the same wire format the tagged-template path produces.
  const sinceIso = since.toISOString();

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

  const rows = await withCustomerScope(customerId, async (tx) => {
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
        date_trunc('hour', ts) AS bucket,
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
  for (let i = 0; i < hours; i++) {
    const ts = new Date(since.getTime() + i * 3_600_000);
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
): Promise<Record<QueryStatus, number>> {
  const result: Record<QueryStatus, number> = {
    ALLOWED: 0,
    DENIED: 0,
    FAILED: 0,
    STUCK: 0,
    PENDING: 0,
    POLICY_RELOAD: 0,
  };
  // ISO text + ::timestamptz cast: see listAuditQueries above for the
  // postgres-js raw-unsafe Date-codec rationale. Same fix applies here.
  const stuckCutoffIso = new Date(
    now().getTime() - STUCK_THRESHOLD_MS,
  ).toISOString();
  return withCustomerScope(customerId, async (tx) => {
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
        'POLICY_RELOAD' AS status,
        count(*)::int AS count
      FROM audit_events_index
      WHERE customer_id = ${customerId}
        AND region = ${region}
        AND event_type IN ('POLICY_RELOADED', 'POLICY_CHANGED', 'TENANT_SCOPE_CHANGED')
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
  customerId: string,
  id: string,
): Promise<AuditEvent | null> {
  return withCustomerScope(customerId, async (tx) => {
    const rows = await tx
      .select()
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.id, id),
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
  customerId: string,
  queryId: string,
): Promise<AuditEvent[]> {
  return withCustomerScope(customerId, async (tx) => {
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
  const db = getDb();
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
  customerId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!ULID_RE.test(customerId)) {
    throw new Error("customer_id must be a ULID");
  }
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`SET LOCAL app.customer_id = '${customerId}'`),
    );
    return fn(tx);
  });
}
