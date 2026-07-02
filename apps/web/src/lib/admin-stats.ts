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

import { and, count, eq, gte, sql } from "drizzle-orm";

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

/** Crockford-alphabet ULID shape — same guard lib/audit.ts uses before it
 *  interpolates a customer id into a `SET LOCAL` (which can't be parameterized).
 *  customers.id is always a ULID, but we re-check defensively before inlining. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

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
  };
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
async function collectRegionStats(region: Region): Promise<RegionStats> {
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
  };

  try {
    const db = getDb(region); // throws when DATABASE_URL_<region> is unset

    const cutoff = new Date(
      Date.now() - ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

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

    const billingPlanCounts = zeroPlanRecord();
    const planCounts = zeroPlanRecord();
    const compedCounts = zeroPlanRecord();
    for (const c of customerRows) {
      const billing = (c.plan ?? "free") as Plan;
      const effective = (c.planOverride ?? c.plan ?? "free") as Plan;
      billingPlanCounts[billing] += 1;
      planCounts[effective] += 1;
      if (c.planOverride) compedCounts[c.planOverride as Plan] += 1;
    }

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
    };
  } catch (err) {
    return { region, reachable: false, error: shortError(err), ...empty };
  }
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
export async function collectAdminStats(hostRegion: Region): Promise<AdminStats> {
  const perRegion = await Promise.all(REGIONS.map(collectRegionStats));

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
  };

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
    addPlanRecords(totals.billingPlanCounts, r.billingPlanCounts);
    addPlanRecords(totals.planCounts, r.planCounts);
    addPlanRecords(totals.compedCounts, r.compedCounts);
    for (const [status, c] of Object.entries(r.subscriptionStatusCounts)) {
      totals.subscriptionStatusCounts[status] =
        (totals.subscriptionStatusCounts[status] ?? 0) + c;
    }
  }
  totals.payingCustomers =
    totals.billingPlanCounts.pro + totals.billingPlanCounts.team;

  const recentSignups = perRegion
    .flatMap((r) => r.recentSignups)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 25);

  return {
    generatedAt: new Date(),
    activityWindowDays: ACTIVITY_WINDOW_DAYS,
    hostRegion,
    perRegion,
    complete: perRegion.every((r) => r.reachable),
    totals,
    recentSignups,
  };
}
