// Internal admin stats — cross-region aggregation for the /admin dashboard.
//
// WHY per-region-with-degradation: each regional web instance only has its OWN
// DATABASE_URL_<REGION> set (data locality — see packages/db getDb). getDb('us')
// from the EU app THROWS by design. So we attempt every region, aggregate the
// ones we can reach, and mark the rest `reachable: false` rather than silently
// under-counting. Where an operator runs a combined instance (both DSNs set —
// dev/staging), this yields a true global view; in region-locked prod it shows
// this host's region and names the others as out-of-reach.
//
// Plan truth (mirrors lib/plan.ts resolvePlan order): customers.plan is the
// subscription-backed tier the Stripe webhook writes (drives REVENUE);
// planOverride is the manual comp lever (no money). We surface both — billing
// plan for MRR, effective plan (override ?? plan) for lived entitlement, and
// the comp count on its own so a comp never inflates the revenue read.
//
// Read-only + best-effort: this never writes, and a single failing query drops
// its region to unreachable instead of 500-ing the whole page.

import { and, count, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import {
  auditEventsIndex,
  customers,
  getDb,
  mcpTokens,
  projectDatabases,
  projects,
  REGIONS,
  type Region,
} from "@midplane-cloud/db";
import {
  member,
  subscription as subscriptionTable,
  user,
} from "@midplane-cloud/db/auth-schema";

import type { Plan } from "./plan.ts";

const PLANS = ["free", "pro", "team"] as const;

/** Activity window for the "are agents actually querying?" pulse. */
const ACTIVITY_WINDOW_DAYS = 7;

/** The switchable time-series metrics. `queries` reads the RLS-forced audit
 *  index (per-customer scoped); the other two are cheap no-RLS reads. */
export const SERIES_METRICS = ["signups", "users", "queries"] as const;
export type SeriesMetric = (typeof SERIES_METRICS)[number];

/** The offered date-range switches, in trailing days. */
export const SERIES_RANGES = [7, 30, 90] as const;
export type SeriesRange = (typeof SERIES_RANGES)[number];

const DEFAULT_METRIC: SeriesMetric = "signups";
const DEFAULT_RANGE: SeriesRange = 30;

/** Parse a metric query param, falling back to the default on anything unknown. */
export function parseMetric(raw: string | undefined): SeriesMetric {
  return SERIES_METRICS.includes(raw as SeriesMetric)
    ? (raw as SeriesMetric)
    : DEFAULT_METRIC;
}

/** Parse a range query param (e.g. "30" or "30d"), falling back to the default. */
export function parseRange(raw: string | undefined): SeriesRange {
  const n = Number(String(raw ?? "").replace(/d$/, ""));
  return (SERIES_RANGES as readonly number[]).includes(n)
    ? (n as SeriesRange)
    : DEFAULT_RANGE;
}

/** UTC calendar-day key ("YYYY-MM-DD") — the bucket for the daily series. */
function dayKeyUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Group-by key that buckets a timestamptz column into its UTC calendar day,
 *  matching dayKeyUTC on the JS side so region merges line up exactly. */
function utcDayExpr(col: unknown) {
  return sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
}

/** Crockford-alphabet ULID shape — same guard lib/audit.ts uses before it
 *  interpolates a customer id into a `SET LOCAL` (which can't be parameterized).
 *  customers.id is always a ULID, but we re-check defensively before inlining. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** One bucket of a trailing daily series. */
export interface DayCount {
  /** UTC "YYYY-MM-DD". */
  day: string;
  count: number;
}

/** The selected time-series: a filled, ordered daily count for one metric over
 *  a trailing range. */
export interface SeriesResult {
  metric: SeriesMetric;
  rangeDays: number;
  /** Filled + ordered oldest→newest, length = rangeDays, merged across regions. */
  points: DayCount[];
}

/** Rolling counts at the three windows the growth tiles render. */
export interface WindowCounts {
  d1: number;
  d7: number;
  d30: number;
}

export interface RecentSignup {
  email: string;
  region: Region;
  /** Effective tier (planOverride ?? plan) — what the customer actually gets. */
  plan: Plan;
  /** True when a manual planOverride is set (comp / support grant, not paid). */
  comped: boolean;
  createdAt: Date;
}

export interface RegionStats {
  region: Region;
  /** False when this host can't reach the region's DB (DSN unset by locality,
   *  or a connection/query error). Its numbers are excluded from the totals. */
  reachable: boolean;
  /** Short reason when unreachable — surfaced verbatim in a muted note. */
  error?: string;
  customers: number;
  users: number;
  members: number;
  projects: number;
  databases: number;
  /** Usable agent identities: kind='url', status='active' MCP tokens. */
  activeAgents: number;
  /** Tally by subscription-backed customers.plan — the revenue read. */
  billingPlanCounts: Record<Plan, number>;
  /** Tally by effective plan (planOverride ?? plan) — lived entitlement. */
  planCounts: Record<Plan, number>;
  /** Customers with a non-null planOverride (comped), by the override tier. */
  compedCounts: Record<Plan, number>;
  /** Live subscription rows tallied by Stripe status. */
  subscriptionStatusCounts: Record<string, number>;
  recentSignups: RecentSignup[];
  /** Distinct projects that ran ≥1 audited query in the activity window. */
  activeProjects: number;
  /** Total audited events in the activity window. */
  events: number;
  /** New customers (orgs) in the trailing 1/7/30d, by customers.created_at. */
  newCustomers: WindowCounts;
  /** New users (accounts) in the trailing 1/7/30d, by user.created_at. */
  newUsers: WindowCounts;
  /** Agents SEEN (kind='url' tokens with a last_used_at) in the trailing 1/7d —
   *  real usage recency, distinct from activeAgents (merely usable). */
  agentsSeen: { d1: number; d7: number };
  /** Entitled subscriptions set to cancel at period end (soft churn signal). */
  pendingCancels: number;
  /** Trials ending within the next 7 days (conversion / churn watch). */
  trialsEndingSoon: number;
  /** Sparse daily counts for the SELECTED metric over the selected range. */
  seriesByDay: DayCount[];
}

export interface AdminStats {
  generatedAt: Date;
  activityWindowDays: number;
  /** The region THIS host is pinned to (bootRegion). */
  hostRegion: Region;
  perRegion: RegionStats[];
  /** Whether every region was reachable — drives the "partial view" banner. */
  complete: boolean;
  totals: {
    customers: number;
    users: number;
    members: number;
    projects: number;
    databases: number;
    activeAgents: number;
    /** billingPlanCounts.pro + billingPlanCounts.team across reachable regions. */
    payingCustomers: number;
    billingPlanCounts: Record<Plan, number>;
    planCounts: Record<Plan, number>;
    compedCounts: Record<Plan, number>;
    subscriptionStatusCounts: Record<string, number>;
    activeProjects: number;
    events: number;
    newCustomers: WindowCounts;
    newUsers: WindowCounts;
    agentsSeen: { d1: number; d7: number };
    pendingCancels: number;
    trialsEndingSoon: number;
  };
  /** The selected metric's daily series (filled), driven by ?metric + ?range. */
  series: SeriesResult;
  recentSignups: RecentSignup[];
}

function zeroPlanRecord(): Record<Plan, number> {
  return { free: 0, pro: 0, team: 0 };
}

/** A short, safe error label for the unreachable-region note. Never leaks a DSN
 *  or stack — just the message's first line, trimmed. */
function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split("\n")[0]!.slice(0, 120);
}

/** Collect stats for one region, or a fully-zeroed unreachable stub. getDb()
 *  throws synchronously when the region's DSN is unset (the locality guard);
 *  a live-but-unreachable DB throws at await time. Both land here. */
async function collectRegionStats(
  region: Region,
  series: { metric: SeriesMetric; rangeDays: number },
): Promise<RegionStats> {
  const empty: Omit<RegionStats, "region" | "reachable" | "error"> = {
    customers: 0,
    users: 0,
    members: 0,
    projects: 0,
    databases: 0,
    activeAgents: 0,
    billingPlanCounts: zeroPlanRecord(),
    planCounts: zeroPlanRecord(),
    compedCounts: zeroPlanRecord(),
    subscriptionStatusCounts: {},
    recentSignups: [],
    activeProjects: 0,
    events: 0,
    newCustomers: { d1: 0, d7: 0, d30: 0 },
    newUsers: { d1: 0, d7: 0, d30: 0 },
    agentsSeen: { d1: 0, d7: 0 },
    pendingCancels: 0,
    trialsEndingSoon: 0,
    seriesByDay: [],
  };

  try {
    const db = getDb(region); // throws when DATABASE_URL_<region> is unset

    const now = Date.now();
    const cutoff = new Date(now - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const day = 24 * 60 * 60 * 1000;
    const d1 = new Date(now - day);
    const d7 = new Date(now - 7 * day);
    const d30 = new Date(now - 30 * day);
    const in7d = new Date(now + 7 * day);
    const seriesFrom = new Date(now - series.rangeDays * day);

    // Customer rows carry both plan axes and the signup timeline. At current
    // (pre-launch) scale fetching all of them and reducing in JS is cheaper to
    // read than a fan-out of GROUP BYs; revisit with SQL aggregation if the
    // customer count ever grows past a few thousand.
    const customerRows = await db
      .select({
        id: customers.id,
        email: customers.email,
        region: customers.region,
        plan: customers.plan,
        planOverride: customers.planOverride,
        createdAt: customers.createdAt,
      })
      .from(customers);

    const [
      usersRes,
      membersRes,
      projectsRes,
      databasesRes,
      agentsRes,
      subscriptionRows,
      newUsersRes,
      agentsSeenRes,
      subSignalsRes,
      activityRes,
    ] = await Promise.all([
      db.select({ users: count() }).from(user),
      db.select({ members: count() }).from(member),
      db.select({ projectCount: count() }).from(projects),
      db.select({ databaseCount: count() }).from(projectDatabases),
      db
        .select({ activeAgents: count() })
        .from(mcpTokens)
        .where(and(eq(mcpTokens.kind, "url"), eq(mcpTokens.status, "active"))),
      db
        .select({ status: subscriptionTable.status, c: count() })
        .from(subscriptionTable)
        .groupBy(subscriptionTable.status),
      // New users by created_at (customers/orgs are computed from the rows we
      // already fetched; users need their own windowed count). The date bounds
      // go through drizzle's gte() — NOT a bare `${date}` in the sql template —
      // so each Date is encoded with the column's timestamp type. A raw Date
      // embed has no column context and postgres.js's prepare:false path (Neon
      // pgbouncer) throws "string argument ... Received an instance of Date".
      db
        .select({
          d1: sql<number>`count(*) filter (where ${gte(user.createdAt, d1)})::int`,
          d7: sql<number>`count(*) filter (where ${gte(user.createdAt, d7)})::int`,
          d30: sql<number>`count(*) filter (where ${gte(user.createdAt, d30)})::int`,
        })
        .from(user),
      // Agents SEEN: kind='url' tokens with a recent last_used_at. Usage
      // recency, not the "usable" activeAgents count.
      db
        .select({
          d1: sql<number>`count(*) filter (where ${gte(mcpTokens.lastUsedAt, d1)})::int`,
          d7: sql<number>`count(*) filter (where ${gte(mcpTokens.lastUsedAt, d7)})::int`,
        })
        .from(mcpTokens)
        .where(eq(mcpTokens.kind, "url")),
      // Churn watch: entitled subs set to cancel, and trials ending ≤7d.
      db
        .select({
          pendingCancels: sql<number>`count(*) filter (where ${and(eq(subscriptionTable.cancelAtPeriodEnd, true), inArray(subscriptionTable.status, ["active", "trialing"]))})::int`,
          trialsEndingSoon: sql<number>`count(*) filter (where ${and(isNotNull(subscriptionTable.trialEnd), gte(subscriptionTable.trialEnd, new Date(now)), lt(subscriptionTable.trialEnd, in7d))})::int`,
        })
        .from(subscriptionTable),
      // audit_events_index is the ONLY RLS table here (FORCE ROW LEVEL
      // SECURITY, tenant-isolated on app.customer_id). Its aggregate needs the
      // per-customer scoped path — see collectAuditActivity.
      collectAuditActivity(
        db,
        customerRows.map((c) => c.id),
        cutoff,
      ),
    ]);

    // Each count query returns exactly one row; ?? 0 satisfies the strict
    // indexed-access check without changing the always-present runtime shape.
    const users = usersRes[0]?.users ?? 0;
    const members = membersRes[0]?.members ?? 0;
    const projectCount = projectsRes[0]?.projectCount ?? 0;
    const databaseCount = databasesRes[0]?.databaseCount ?? 0;
    const activeAgents = agentsRes[0]?.activeAgents ?? 0;
    const activity = activityRes; // { activeProjects, events }
    const newUsers: WindowCounts = {
      d1: Number(newUsersRes[0]?.d1 ?? 0),
      d7: Number(newUsersRes[0]?.d7 ?? 0),
      d30: Number(newUsersRes[0]?.d30 ?? 0),
    };
    const agentsSeen = {
      d1: Number(agentsSeenRes[0]?.d1 ?? 0),
      d7: Number(agentsSeenRes[0]?.d7 ?? 0),
    };
    const pendingCancels = Number(subSignalsRes[0]?.pendingCancels ?? 0);
    const trialsEndingSoon = Number(subSignalsRes[0]?.trialsEndingSoon ?? 0);

    const billingPlanCounts = zeroPlanRecord();
    const planCounts = zeroPlanRecord();
    const compedCounts = zeroPlanRecord();
    // New-customer windows come from the rows we already fetched — no query.
    const newCustomers: WindowCounts = { d1: 0, d7: 0, d30: 0 };
    for (const c of customerRows) {
      const billing = (c.plan ?? "free") as Plan;
      const effective = (c.planOverride ?? c.plan ?? "free") as Plan;
      billingPlanCounts[billing] += 1;
      planCounts[effective] += 1;
      if (c.planOverride) compedCounts[c.planOverride as Plan] += 1;

      const t = c.createdAt.getTime();
      if (t >= d30.getTime()) newCustomers.d30 += 1;
      if (t >= d7.getTime()) newCustomers.d7 += 1;
      if (t >= d1.getTime()) newCustomers.d1 += 1;
    }

    // Only the SELECTED metric's series is computed — the `queries` path scans
    // the RLS audit index (per-customer), so we never pay for it unless it's on
    // screen. `signups` reuses the rows already fetched (free); `users` runs one
    // grouped read; `queries` runs the scoped daily aggregate.
    const seriesByDay = await collectSeriesByDay(
      db,
      series.metric,
      seriesFrom,
      customerRows,
    );

    const subscriptionStatusCounts: Record<string, number> = {};
    for (const row of subscriptionRows) {
      subscriptionStatusCounts[row.status] = Number(row.c);
    }

    const recentSignups: RecentSignup[] = [...customerRows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 25)
      .map((c) => ({
        email: c.email,
        region: c.region,
        plan: (c.planOverride ?? c.plan ?? "free") as Plan,
        comped: c.planOverride != null,
        createdAt: c.createdAt,
      }));

    return {
      region,
      reachable: true,
      customers: customerRows.length,
      users: Number(users),
      members: Number(members),
      projects: Number(projectCount),
      databases: Number(databaseCount),
      activeAgents: Number(activeAgents),
      billingPlanCounts,
      planCounts,
      compedCounts,
      subscriptionStatusCounts,
      recentSignups,
      activeProjects: activity.activeProjects,
      events: activity.events,
      newCustomers,
      newUsers,
      agentsSeen,
      pendingCancels,
      trialsEndingSoon,
      seriesByDay,
    };
  } catch (err) {
    return { region, reachable: false, error: shortError(err), ...empty };
  }
}

/** Sparse daily buckets for one metric since `from`. `signups` reduces the
 *  already-fetched customer rows (no query); `users` is one grouped read;
 *  `queries` is the RLS-scoped daily audit aggregate. */
async function collectSeriesByDay(
  db: ReturnType<typeof getDb>,
  metric: SeriesMetric,
  from: Date,
  customerRows: Array<{ id: string; createdAt: Date }>,
): Promise<DayCount[]> {
  if (metric === "signups") {
    const b = new Map<string, number>();
    const fromMs = from.getTime();
    for (const c of customerRows) {
      if (c.createdAt.getTime() < fromMs) continue;
      const k = dayKeyUTC(c.createdAt);
      b.set(k, (b.get(k) ?? 0) + 1);
    }
    return [...b.entries()].map(([day, count]) => ({ day, count }));
  }

  if (metric === "users") {
    const dayExpr = utcDayExpr(user.createdAt);
    const rows = await db
      .select({ day: dayExpr, c: count() })
      .from(user)
      .where(gte(user.createdAt, from))
      .groupBy(dayExpr);
    return rows.map((r) => ({ day: r.day, count: Number(r.c) }));
  }

  // queries: daily audit-event counts, per-customer scoped (same RLS reason as
  // collectAuditActivity) then merged by day. One grouped read per customer.
  return collectAuditDailySeries(
    db,
    customerRows.map((c) => c.id),
    from,
  );
}

async function collectAuditDailySeries(
  db: ReturnType<typeof getDb>,
  customerIds: string[],
  from: Date,
): Promise<DayCount[]> {
  if (customerIds.length === 0) return [];
  const dayExpr = utcDayExpr(auditEventsIndex.ts);
  return db.transaction(async (tx) => {
    const buckets = new Map<string, number>();
    for (const id of customerIds) {
      if (!ULID_RE.test(id)) continue;
      await tx.execute(sql.raw(`SET LOCAL app.customer_id = '${id}'`));
      const rows = await tx
        .select({ day: dayExpr, c: count() })
        .from(auditEventsIndex)
        .where(gte(auditEventsIndex.ts, from))
        .groupBy(dayExpr);
      for (const r of rows) {
        buckets.set(r.day, (buckets.get(r.day) ?? 0) + Number(r.c));
      }
    }
    return [...buckets.entries()].map(([day, count]) => ({ day, count }));
  });
}

/** 7-day activity from the audit index, summed across customers.
 *
 *  audit_events_index is FORCE ROW LEVEL SECURITY with a tenant-isolation
 *  policy (customer_id = current_setting('app.customer_id', true)). A
 *  cross-customer aggregate that doesn't bind app.customer_id matches the NULL
 *  setting and reads ZERO rows — so this MUST scope per customer. A SECURITY
 *  DEFINER function can't rescue it either: FORCE RLS applies to the definer
 *  unless that role holds BYPASSRLS, which Neon's non-superuser role can't be
 *  granted. So we bind per customer inside one transaction (the same SET LOCAL
 *  idiom lib/audit.ts uses) and sum. Every project belongs to exactly one
 *  customer, so summed per-customer distinct-project counts equal the global
 *  distinct count — no double-count. O(customers) statements in a single
 *  transaction; fine at current scale, revisit if the customer count grows. */
async function collectAuditActivity(
  db: ReturnType<typeof getDb>,
  customerIds: string[],
  cutoff: Date,
): Promise<{ activeProjects: number; events: number }> {
  if (customerIds.length === 0) return { activeProjects: 0, events: 0 };
  return db.transaction(async (tx) => {
    let activeProjects = 0;
    let events = 0;
    for (const id of customerIds) {
      // SET LOCAL can't be parameterized; the ULID guard makes the interpolation
      // injection-safe. A malformed id (shouldn't happen — it's a PK) is skipped
      // rather than binding an unvalidated string.
      if (!ULID_RE.test(id)) continue;
      await tx.execute(sql.raw(`SET LOCAL app.customer_id = '${id}'`));
      const rows = await tx
        .select({
          activeProjects: sql<number>`count(distinct ${auditEventsIndex.projectId})::int`,
          events: sql<number>`count(*)::int`,
        })
        .from(auditEventsIndex)
        .where(gte(auditEventsIndex.ts, cutoff));
      activeProjects += Number(rows[0]?.activeProjects ?? 0);
      events += Number(rows[0]?.events ?? 0);
    }
    return { activeProjects, events };
  });
}

function addPlanRecords(
  into: Record<Plan, number>,
  from: Record<Plan, number>,
): void {
  for (const p of PLANS) into[p] += from[p];
}

/** Aggregate every region into the admin dashboard's view model. Reads the
 *  host's pinned region for the "partial view" note; totals sum only reachable
 *  regions. `bootRegion` is injected so the caller owns the region-context
 *  import (keeps this module free of the request-scope seam). */
export async function collectAdminStats(
  hostRegion: Region,
  opts: { metric: SeriesMetric; rangeDays: SeriesRange },
): Promise<AdminStats> {
  const perRegion = await Promise.all(
    REGIONS.map((r) => collectRegionStats(r, opts)),
  );

  const totals: AdminStats["totals"] = {
    customers: 0,
    users: 0,
    members: 0,
    projects: 0,
    databases: 0,
    activeAgents: 0,
    payingCustomers: 0,
    billingPlanCounts: zeroPlanRecord(),
    planCounts: zeroPlanRecord(),
    compedCounts: zeroPlanRecord(),
    subscriptionStatusCounts: {},
    activeProjects: 0,
    events: 0,
    newCustomers: { d1: 0, d7: 0, d30: 0 },
    newUsers: { d1: 0, d7: 0, d30: 0 },
    agentsSeen: { d1: 0, d7: 0 },
    pendingCancels: 0,
    trialsEndingSoon: 0,
  };

  // Merged sparse day→count map for the selected metric (reachable regions).
  const seriesBuckets = new Map<string, number>();

  for (const r of perRegion) {
    if (!r.reachable) continue;
    totals.customers += r.customers;
    totals.users += r.users;
    totals.members += r.members;
    totals.projects += r.projects;
    totals.databases += r.databases;
    totals.activeAgents += r.activeAgents;
    totals.activeProjects += r.activeProjects;
    totals.events += r.events;
    totals.pendingCancels += r.pendingCancels;
    totals.trialsEndingSoon += r.trialsEndingSoon;
    for (const k of ["d1", "d7", "d30"] as const) {
      totals.newCustomers[k] += r.newCustomers[k];
      totals.newUsers[k] += r.newUsers[k];
    }
    totals.agentsSeen.d1 += r.agentsSeen.d1;
    totals.agentsSeen.d7 += r.agentsSeen.d7;
    addPlanRecords(totals.billingPlanCounts, r.billingPlanCounts);
    addPlanRecords(totals.planCounts, r.planCounts);
    addPlanRecords(totals.compedCounts, r.compedCounts);
    for (const [status, c] of Object.entries(r.subscriptionStatusCounts)) {
      totals.subscriptionStatusCounts[status] =
        (totals.subscriptionStatusCounts[status] ?? 0) + c;
    }
    for (const { day, count } of r.seriesByDay) {
      seriesBuckets.set(day, (seriesBuckets.get(day) ?? 0) + count);
    }
  }
  totals.payingCustomers =
    totals.billingPlanCounts.pro + totals.billingPlanCounts.team;

  const recentSignups = perRegion
    .flatMap((r) => r.recentSignups)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 25);

  const generatedAt = new Date();
  // Fill the series to a dense, ordered oldest→newest axis so the chart renders
  // gaps as empty bars (not skipped days). Anchored on generatedAt (UTC days).
  const day = 24 * 60 * 60 * 1000;
  const points: DayCount[] = [];
  for (let i = opts.rangeDays - 1; i >= 0; i--) {
    const key = dayKeyUTC(new Date(generatedAt.getTime() - i * day));
    points.push({ day: key, count: seriesBuckets.get(key) ?? 0 });
  }

  return {
    generatedAt,
    activityWindowDays: ACTIVITY_WINDOW_DAYS,
    hostRegion,
    perRegion,
    complete: perRegion.every((r) => r.reachable),
    totals,
    series: { metric: opts.metric, rangeDays: opts.rangeDays, points },
    recentSignups,
  };
}
