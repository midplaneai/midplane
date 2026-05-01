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

import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import {
  auditEventsIndex,
  getDb,
  indexerCursors,
  type AuditEvent,
  type Region,
} from "@midplane-cloud/db";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const EVENT_TYPES = [
  "ATTEMPTED",
  "DECIDED",
  "EXECUTED",
  "FAILED",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export interface AuditListRow {
  id: string;
  ts: Date;
  eventType: string;
  agentIdentity: string | null;
  queryId: string;
  tenantId: string;
  sqlFingerprint: string | null;
}

export interface ListAuditOpts {
  region: Region;
  /** Empty = all event types (no filter applied). */
  eventTypes?: readonly EventType[];
  /** Empty/undefined = all tenants. Single value per V1 mockup. */
  tenantId?: string;
  /** Empty/undefined = all databases. The name is the OSS-side `database:`
   *  on a connection (the per-DB row in `connection_databases`), not a
   *  per-client connection. Hits audit_customer_region_database_ts_idx. */
  database?: string;
  /** Substring match against payload->>'sql_fingerprint' OR query_id. */
  search?: string;
  /** Last id from the previous page (id DESC ordering). Cursor is exclusive. */
  cursor?: string;
  /** Page size; default 50. The query asks for limit+1 so callers can detect
   *  whether a next page exists without a second COUNT round-trip. */
  pageSize?: number;
}

export interface ListAuditResult {
  rows: AuditListRow[];
  nextCursor: string | null;
}

/** List audit rows for the current customer, RLS-scoped + region-pinned. */
export async function listAuditEvents(
  customerId: string,
  opts: ListAuditOpts,
): Promise<ListAuditResult> {
  const limit = opts.pageSize ?? 50;
  return withCustomerScope(customerId, async (tx) => {
    const filters = [
      eq(auditEventsIndex.customerId, customerId),
      eq(auditEventsIndex.region, opts.region),
    ];
    if (opts.cursor) filters.push(lt(auditEventsIndex.id, opts.cursor));
    if (opts.eventTypes && opts.eventTypes.length > 0) {
      filters.push(inArray(auditEventsIndex.eventType, [...opts.eventTypes]));
    }
    if (opts.tenantId) {
      filters.push(eq(auditEventsIndex.tenantId, opts.tenantId));
    }
    if (opts.database) {
      filters.push(eq(auditEventsIndex.database, opts.database));
    }
    if (opts.search && opts.search.trim().length > 0) {
      const needle = `%${opts.search.trim()}%`;
      filters.push(
        or(
          sql`${auditEventsIndex.payload} ->> 'sql_fingerprint' ILIKE ${needle}`,
          sql`${auditEventsIndex.queryId} ILIKE ${needle}`,
        )!,
      );
    }

    const rows = await tx
      .select({
        id: auditEventsIndex.id,
        ts: auditEventsIndex.ts,
        eventType: auditEventsIndex.eventType,
        agentIdentity: auditEventsIndex.agentIdentity,
        queryId: auditEventsIndex.queryId,
        tenantId: auditEventsIndex.tenantId,
        sqlFingerprint: sql<
          string | null
        >`${auditEventsIndex.payload} ->> 'sql_fingerprint'`,
      })
      .from(auditEventsIndex)
      .where(and(...filters))
      .orderBy(desc(auditEventsIndex.id))
      .limit(limit + 1);

    const next = rows.length > limit ? (rows[limit - 1]?.id ?? null) : null;
    return { rows: rows.slice(0, limit), nextCursor: next };
  });
}

/** Distinct tenant_ids the current customer has audit rows for, used to
 *  populate the tenant filter chip. Capped at 50 — past that, the chip UI
 *  stops being useful and the search box is the better tool. */
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
      .limit(50);
    return rows.map((r) => r.tenantId).sort();
  });
}

/** Distinct database names for the customer in this region. The values are
 *  the OSS-side `database:` field stamped on each audit row (one row per DB
 *  attached to a connection). Capped at 50 for the same reason as tenants. */
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
      .limit(50);
    return rows.map((r) => r.database).sort();
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
export async function eventVolumeByHour(
  customerId: string,
  region: Region,
  opts: { hours?: number; now?: () => Date } = {},
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
            OR (event_type = 'DECIDED' AND payload ->> 'decision' = 'deny')
          )
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

/** Counts per event_type, used to render the badges next to each filter
 *  chip. RLS-scoped + region-pinned; cheap because the compound index
 *  (customer_id, region, event_type, ts DESC) is index-only-scan friendly. */
export async function countByEventType(
  customerId: string,
  region: Region,
): Promise<Record<EventType, number>> {
  const result: Record<EventType, number> = {
    ATTEMPTED: 0,
    DECIDED: 0,
    EXECUTED: 0,
    FAILED: 0,
  };
  return withCustomerScope(customerId, async (tx) => {
    const rows = await tx
      .select({
        eventType: auditEventsIndex.eventType,
        count: sql<number>`count(*)::int`,
      })
      .from(auditEventsIndex)
      .where(
        and(
          eq(auditEventsIndex.customerId, customerId),
          eq(auditEventsIndex.region, region),
        ),
      )
      .groupBy(auditEventsIndex.eventType);
    for (const r of rows) {
      if ((EVENT_TYPES as readonly string[]).includes(r.eventType)) {
        result[r.eventType as EventType] = Number(r.count);
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
