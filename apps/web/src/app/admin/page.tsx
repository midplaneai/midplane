import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RegionBadge } from "@/components/ui/region-badge";
import {
  collectAdminStats,
  parseMetric,
  parseRange,
  SERIES_METRICS,
  SERIES_RANGES,
  type AdminStats,
  type DayCount,
  type RecentSignup,
  type RegionStats,
  type SeriesMetric,
  type SeriesRange,
  type WindowCounts,
} from "@/lib/admin-stats";
import { formatRelative } from "@/lib/format";
import { getOrgContext } from "@/lib/org-context";
import { PLAN_PRICING, type Plan } from "@/lib/plan";
import { bootRegion } from "@/lib/region-context";
import { isStaffUserId } from "@/lib/staff";
import { cn } from "@/lib/utils";

// Staff-only internal stats. The page reads the session + live DB, so it must
// never be cached: force-dynamic. Non-staff (incl. unauthenticated) get a 404,
// not a 403 — the surface doesn't announce its own existence to customers.
export const dynamic = "force-dynamic";

const PLANS: Plan[] = ["free", "pro", "team"];

// Bar/legend hues for the plan mix — free muted, pro mid-brand, team full-brand.
// Semantic tokens only (no raw green/red); the ramp reads as "more paid = more
// brand", consistent with the rest of the app's brand accenting.
const PLAN_SWATCH: Record<Plan, string> = {
  free: "bg-[hsl(var(--muted-foreground)/0.35)]",
  pro: "bg-[hsl(var(--brand)/0.55)]",
  team: "bg-[hsl(var(--brand))]",
};

function planPriceUsd(tier: Plan): number {
  return Number(PLAN_PRICING[tier].amount.replace(/[^0-9.]/g, "")) || 0;
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US")}`;
}

// Live vs. lapsed vs. never-started, in semantic tones.
function statusVariant(status: string): "allow" | "warn" | "default" {
  if (status === "active" || status === "trialing") return "allow";
  if (status === "past_due" || status === "unpaid" || status === "paused")
    return "warn";
  return "default";
}

// Human labels for the metric toggle. Audit rows are query-lifecycle events, so
// the honest name is "query events" (config events are a rare minority).
const METRIC_LABEL: Record<SeriesMetric, string> = {
  signups: "signups",
  users: "new users",
  queries: "query events",
};

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ metric?: string; range?: string }>;
}) {
  const { userId } = await getOrgContext();
  if (!isStaffUserId(userId)) notFound();

  const sp = await searchParams;
  const metric = parseMetric(sp.metric);
  const rangeDays = parseRange(sp.range);

  const stats = await collectAdminStats(bootRegion(), { metric, rangeDays });
  const { totals } = stats;

  const mrr =
    totals.billingPlanCounts.pro * planPriceUsd("pro") +
    totals.billingPlanCounts.team * planPriceUsd("team");
  const compedTotal = PLANS.reduce((n, p) => n + totals.compedCounts[p], 0);
  const generated = `${stats.generatedAt.toISOString().slice(0, 19).replace("T", " ")} UTC`;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={
          <>
            Midplane internal metrics · generated {generated} · activity window{" "}
            {stats.activityWindowDays}d
          </>
        }
      />

      {!stats.complete ? <PartialViewBanner stats={stats} /> : null}

      {/* Top-line KPIs — the numbers a founder checks first: reach, revenue,
          and whether the product is actually being used. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="customers" value={totals.customers} />
        <StatTile label="users" value={totals.users} />
        <StatTile
          label="paying"
          value={totals.payingCustomers}
          tone={totals.payingCustomers > 0 ? "text-[hsl(var(--brand))]" : undefined}
        />
        <StatTile
          label="est. mrr"
          value={usd(mrr)}
          tone={mrr > 0 ? "text-[hsl(var(--brand))]" : undefined}
        />
        <StatTile label="projects" value={totals.projects} />
        <StatTile
          label="active agents"
          value={totals.activeAgents}
          tone={
            totals.activeAgents === 0 ? "text-[hsl(var(--warn))]" : undefined
          }
        />
      </div>

      <div className="mt-6">
        <TimeSeriesCard stats={stats} metric={metric} rangeDays={rangeDays} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <PlanMixCard totals={totals} mrr={mrr} compedTotal={compedTotal} />
        <SubscriptionsCard totals={totals} />
      </div>

      <div className="mt-6">
        <RegionSplitCard stats={stats} />
      </div>

      <div className="mt-6">
        <ActivityCard totals={totals} windowDays={stats.activityWindowDays} />
      </div>

      <div className="mt-6">
        <RecentSignupsCard signups={stats.recentSignups} />
      </div>
    </>
  );
}

// --- banner ------------------------------------------------------------------

function PartialViewBanner({ stats }: { stats: AdminStats }) {
  const unreachable = stats.perRegion.filter((r) => !r.reachable);
  return (
    <div className="mb-5 rounded-none border border-[hsl(var(--warn)/0.25)] bg-[hsl(var(--warn)/0.06)] px-4 py-3 text-xs text-muted-foreground">
      <span className="font-medium text-[hsl(var(--warn))]">Partial view.</span>{" "}
      This host serves{" "}
      <span className="font-mono uppercase">{stats.hostRegion}</span> and cannot
      reach {unreachable.map((r) => r.region.toUpperCase()).join(", ")} — their
      numbers are excluded from the totals. Open the admin page on each region
      host for a complete picture.
      <ul className="mt-1.5 space-y-0.5">
        {unreachable.map((r) => (
          <li key={r.region} className="font-mono text-[11px] text-subtle">
            {r.region.toUpperCase()}: {r.error}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- KPI tile ----------------------------------------------------------------

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: string;
}) {
  return (
    <Card className="p-4">
      <div
        className={cn(
          "font-mono text-2xl tabular-nums",
          tone ?? "text-foreground",
        )}
      >
        {value}
      </div>
      <div className="mt-1 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
        {label}
      </div>
    </Card>
  );
}

// --- time series (metric + range switchable) ---------------------------------

function seriesHref(metric: SeriesMetric, rangeDays: number): string {
  return `/admin?metric=${metric}&range=${rangeDays}`;
}

function TimeSeriesCard({
  stats,
  metric,
  rangeDays,
}: {
  stats: AdminStats;
  metric: SeriesMetric;
  rangeDays: SeriesRange;
}) {
  const { totals, series } = stats;
  const totalInWindow = series.points.reduce((n, d) => n + d.count, 0);
  const tab =
    "rounded-[3px] px-2 py-1 font-mono text-[11px] lowercase tracking-[0.04em] transition-colors";
  const on = "bg-secondary text-foreground";
  const off = "text-subtle hover:text-foreground";

  return (
    <Card>
      {/* Custom header row (not CardHeader — which is flex-col) so the switches
          sit inline with the title. Filters live in one row above the chart. */}
      <div className="flex flex-col gap-3 p-6 pb-3 lg:flex-row lg:items-center lg:justify-between">
        <CardTitle>
          {METRIC_LABEL[metric]} · last {rangeDays}d
        </CardTitle>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex items-center gap-1">
            {SERIES_METRICS.map((m) => (
              <Link
                key={m}
                href={seriesHref(m, rangeDays)}
                className={cn(tab, m === metric ? on : off)}
              >
                {METRIC_LABEL[m]}
              </Link>
            ))}
          </div>
          <span className="text-subtle" aria-hidden>
            ·
          </span>
          <div className="flex items-center gap-1">
            {SERIES_RANGES.map((r) => (
              <Link
                key={r}
                href={seriesHref(metric, r)}
                className={cn(tab, r === rangeDays ? on : off)}
              >
                {r}d
              </Link>
            ))}
          </div>
        </div>
      </div>
      <CardContent className="space-y-4 pt-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl tabular-nums text-foreground">
            {totalInWindow.toLocaleString("en-US")}
          </span>
          <span className="font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
            {METRIC_LABEL[metric]} in {rangeDays}d
          </span>
        </div>

        <SeriesChart data={series.points} metric={metric} />

        <div className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-3">
          <Delta label="new customers" w={totals.newCustomers} />
          <Delta label="new users" w={totals.newUsers} />
          <div>
            <div className="font-mono text-sm tabular-nums text-foreground">
              {totals.agentsSeen.d1}
              <span className="text-subtle"> · {totals.agentsSeen.d7}</span>
            </div>
            <div className="mt-1 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
              agents seen · 24h·7d
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Server-rendered daily bar chart — no client charting lib, matching the
// mono/minimal aesthetic (square marks, per the radius-0 system). Container is
// fixed-height + items-stretch so each column is full height and the inner
// bar's height % resolves against it. Single series → brand hue, no legend
// (the title names it). Native title = per-bar hover.
function SeriesChart({
  data,
  metric,
}: {
  data: DayCount[];
  metric: SeriesMetric;
}) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const first = data[0]?.day;
  const last = data[data.length - 1]?.day;
  return (
    <div>
      <div className="flex h-24 items-stretch gap-[2px]">
        {data.map((d) => (
          <div
            key={d.day}
            className="group flex flex-1 items-end"
            title={`${d.day}: ${d.count} ${METRIC_LABEL[metric]}`}
          >
            <div
              className={cn(
                "w-full transition-colors",
                d.count > 0
                  ? "bg-[hsl(var(--brand)/0.65)] group-hover:bg-[hsl(var(--brand))]"
                  : "bg-transparent",
              )}
              style={{ height: `${(d.count / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between border-t border-border pt-1.5 font-mono text-[10px] text-subtle">
        {/* MM-DD endpoints anchor the axis without labeling every day. */}
        <span>{first?.slice(5)}</span>
        <span>{last?.slice(5)}</span>
      </div>
    </div>
  );
}

// One growth stat rendered as three trailing windows (24h · 7d · 30d).
function Delta({ label, w }: { label: string; w: WindowCounts }) {
  return (
    <div>
      <div className="font-mono text-sm tabular-nums text-foreground">
        {w.d1}
        <span className="text-subtle"> · {w.d7}</span>
        <span className="text-subtle"> · {w.d30}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
        {label} · 24h·7d·30d
      </div>
    </div>
  );
}

// --- plan mix ----------------------------------------------------------------

function PlanMixCard({
  totals,
  mrr,
  compedTotal,
}: {
  totals: AdminStats["totals"];
  mrr: number;
  compedTotal: number;
}) {
  const total = totals.customers || 1; // avoid /0 on an empty instance
  return (
    <Card>
      <CardHeader>
        <CardTitle>plan mix (billing)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stacked bar, billing plan (customers.plan) — the revenue-true split;
            comps are broken out below so they never inflate the paid read. */}
        <div className="flex h-2 w-full overflow-hidden rounded-[3px] bg-secondary">
          {PLANS.map((p) => {
            const c = totals.billingPlanCounts[p];
            if (c === 0) return null;
            return (
              <div
                key={p}
                className={PLAN_SWATCH[p]}
                style={{ width: `${(c / total) * 100}%` }}
                title={`${p}: ${c}`}
              />
            );
          })}
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {PLANS.map((p) => (
            <div key={p} className="flex items-center gap-2">
              <span
                className={cn("h-2 w-2 rounded-full", PLAN_SWATCH[p])}
                aria-hidden
              />
              <span className="font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
                {p}
              </span>
              <span className="font-mono text-sm tabular-nums text-foreground">
                {totals.billingPlanCounts[p]}
              </span>
            </div>
          ))}
        </div>

        <div className="border-t border-border pt-3 text-xs text-muted-foreground">
          Est. MRR{" "}
          <span className="font-mono text-foreground">{usd(mrr)}</span>/mo ·{" "}
          {compedTotal === 0 ? (
            "no comped overrides"
          ) : (
            <>
              <span className="font-mono text-foreground">{compedTotal}</span>{" "}
              comped (override, not billed:{" "}
              {PLANS.filter((p) => totals.compedCounts[p] > 0)
                .map((p) => `${totals.compedCounts[p]}→${p}`)
                .join(", ")}
              )
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// --- subscriptions -----------------------------------------------------------

function SubscriptionsCard({ totals }: { totals: AdminStats["totals"] }) {
  const entries = Object.entries(totals.subscriptionStatusCounts).sort(
    (a, b) => b[1] - a[1],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>subscriptions by status</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No subscription rows yet.
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {entries.map(([status, c]) => (
                <li
                  key={status}
                  className="flex items-center justify-between gap-3"
                >
                  <Badge variant={statusVariant(status)}>{status}</Badge>
                  <span className="font-mono text-sm tabular-nums text-foreground">
                    {c}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-border pt-3 text-xs text-muted-foreground">
              <span
                className={
                  totals.pendingCancels > 0 ? "text-[hsl(var(--warn))]" : undefined
                }
              >
                {totals.pendingCancels}
              </span>{" "}
              set to cancel ·{" "}
              <span
                className={
                  totals.trialsEndingSoon > 0
                    ? "text-[hsl(var(--warn))]"
                    : undefined
                }
              >
                {totals.trialsEndingSoon}
              </span>{" "}
              trial{totals.trialsEndingSoon === 1 ? "" : "s"} ending ≤7d
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// --- region split ------------------------------------------------------------

function RegionSplitCard({ stats }: { stats: AdminStats }) {
  const headCell =
    "px-3 py-2 text-right font-mono text-[11px] lowercase tracking-[0.04em] text-subtle";
  const cell = "px-3 py-2 text-right font-mono text-sm tabular-nums text-foreground";
  return (
    <Card>
      <CardHeader>
        <CardTitle>by region</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="px-3 py-2 text-left font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
                region
              </th>
              <th className={headCell}>customers</th>
              <th className={headCell}>users</th>
              <th className={headCell}>projects</th>
              <th className={headCell}>paying</th>
              <th className={headCell}>agents</th>
            </tr>
          </thead>
          <tbody>
            {stats.perRegion.map((r) => (
              <RegionRow
                key={r.region}
                r={r}
                cell={cell}
                isHost={r.region === stats.hostRegion}
              />
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function RegionRow({
  r,
  cell,
  isHost,
}: {
  r: RegionStats;
  cell: string;
  isHost: boolean;
}) {
  if (!r.reachable) {
    return (
      <tr className="border-b border-border last:border-0">
        <td className="px-3 py-2">
          <RegionBadge region={r.region} />
        </td>
        <td colSpan={5} className="px-3 py-2 text-left text-xs text-muted-foreground">
          not reachable from this host{isHost ? " (bootRegion)" : ""} — {r.error}
        </td>
      </tr>
    );
  }
  const paying = r.billingPlanCounts.pro + r.billingPlanCounts.team;
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2 text-left">
        <RegionBadge region={r.region} />
      </td>
      <td className={cell}>{r.customers}</td>
      <td className={cell}>{r.users}</td>
      <td className={cell}>{r.projects}</td>
      <td className={cell}>{paying}</td>
      <td className={cell}>{r.activeAgents}</td>
    </tr>
  );
}

// --- activity ----------------------------------------------------------------

function ActivityCard({
  totals,
  windowDays,
}: {
  totals: AdminStats["totals"];
  windowDays: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>activity · last {windowDays}d</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-x-12 gap-y-4">
          <div>
            <div className="font-mono text-xl tabular-nums text-foreground">
              {totals.activeProjects}
              <span className="text-subtle"> / {totals.projects}</span>
            </div>
            <div className="mt-1 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
              active projects
            </div>
          </div>
          <div>
            <div className="font-mono text-xl tabular-nums text-foreground">
              {totals.events.toLocaleString("en-US")}
            </div>
            <div className="mt-1 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
              audit events
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// --- recent signups ----------------------------------------------------------

function RecentSignupsCard({ signups }: { signups: RecentSignup[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>recent signups</CardTitle>
      </CardHeader>
      <CardContent className={signups.length === 0 ? undefined : "p-0"}>
        {signups.length === 0 ? (
          <EmptyState title="No signups yet" className="border-0 bg-transparent" />
        ) : (
          <table className="w-full">
            <tbody>
              {signups.map((s, i) => (
                <tr
                  key={`${s.email}-${i}`}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-3 py-2 font-mono text-[11px] text-subtle">
                    {formatRelative(s.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-sm text-foreground">
                    {s.email}
                  </td>
                  <td className="px-3 py-2">
                    <RegionBadge region={s.region} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-2">
                      <span className="font-mono text-[11px] lowercase tracking-[0.04em] text-muted-foreground">
                        {s.plan}
                      </span>
                      {s.comped ? (
                        <Badge variant="accent">comped</Badge>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
