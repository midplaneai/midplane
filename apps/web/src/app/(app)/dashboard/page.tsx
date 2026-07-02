import { Plus } from "lucide-react";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { ProjectRowMenu } from "@/components/dashboard/project-row-menu";
import { ProjectServiceControl } from "@/components/dashboard/project-service-control";
import { DatabaseRow } from "@/components/dashboard/database-row";
import {
  DashboardFreshnessProvider,
  type FreshnessInitial,
} from "@/components/dashboard/freshness-provider";
import { LiveProjectFreshness } from "@/components/dashboard/live-project-freshness";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RegionBadge } from "@/components/ui/region-badge";
import {
  type DashboardProjectRow,
  type DashboardDatabase,
  deleteProject,
  emitConfigAuditRow,
  listDashboardProjects,
  pauseProject,
  resumeProject,
} from "@/lib/projects";
import { currentCustomer } from "@/lib/customer";
import { assertManager, isManager } from "@/lib/org-auth";
import { projectLabel, formatRelative } from "@/lib/format";
import { resolvePlan, UPGRADE_URL } from "@/lib/plan";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { getPostHog } from "@/lib/posthog";
import { cn } from "@/lib/utils";

// PR2 of mcp_url_auth_security: the dashboard no longer renders the
// agent-facing URL because the plaintext token is not retrievable from
// the DB (only its HMAC digest is stored). The "Setup agent" sheet and
// per-row URL display are removed from this page; PR3 owns the token
// management surface (list / create / revoke) that replaces them.

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string | string[] }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup");

  // An older create flow redirected to /dashboard?setup=<id> to auto-open
  // the agent setup sheet. New projects now land on the project's Connect
  // tab instead. Strip the stale param if a bookmarked URL still carries it.
  void searchParams;

  // Owner/admin can add, pause, and delete projects; a member operates them
  // (connects agents, runs queries) but sees no management controls.
  const canManage = await isManager();

  const { caps } = await resolvePlan();
  const rows = await listDashboardProjects(
    customer,
    caps.auditRetentionDays,
  );

  // D1 (plan-design-review): a single-project customer skips the one-row list
  // and lands on the project itself — the container stays invisible until there
  // is more than one. An empty default project renders its own setup hero (see
  // the projects/[id] empty state).
  if (rows.length === 1) {
    redirect(`/projects/${rows[0]!.project.id}`);
  }

  // Surface the project cap in the header so the limit is visible before
  // the user tries to add one (and the create form already guards the same
  // cap on /projects/new). Unlimited (Team) shows no counter. atLimit
  // only fires when rows is non-empty, so it never collides with the
  // empty-state branch below.
  const projectLimit = caps.projects;
  const atProjectLimit =
    Number.isFinite(projectLimit) && rows.length >= projectLimit;

  return (
    <>
      <Topbar>
        <Breadcrumb items={[{ label: "Projects" }]} />
      </Topbar>
      <PageContainer>
        <PageHeader
          title="Projects"
          subtitle={
            <>
              Each project is a{" "}
              <strong className="font-medium text-foreground">
                hosted MCP endpoint
              </strong>{" "}
              with one or more databases. Point your agent at the URL; Midplane
              proxies its calls to the database under your access policy.
            </>
          }
          actions={
            <div className="flex items-center gap-3">
              {Number.isFinite(projectLimit) ? (
                <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-subtle">
                  {rows.length} / {projectLimit}
                </span>
              ) : null}
              {/* Members can't add projects — show the counter, hide the CTA. */}
              {canManage &&
                (atProjectLimit ? (
                  <Link href={UPGRADE_URL}>
                    <Button size="sm" variant="outline">
                      Upgrade to add more
                    </Button>
                  </Link>
                ) : (
                  <Link href="/projects/new">
                    <Button size="sm">
                      <Plus className="mr-1 h-3.5 w-3.5" strokeWidth={1.5} />
                      New project
                    </Button>
                  </Link>
                ))}
            </div>
          }
        />

        {rows.length === 0 ? (
          <EmptyState
            title="No projects yet"
            description={
              <>
                Add a Postgres project to get a{" "}
                <strong className="font-medium text-foreground">
                  hosted MCP endpoint
                </strong>
                .
              </>
            }
            action={
              canManage ? (
                <Link href="/projects/new">
                  <Button size="sm">Connect Postgres</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <DashboardFreshnessProvider initial={initialFreshness(rows)}>
            <ul className="space-y-3">
              {rows.map((row) => (
                <ProjectCard
                  key={row.project.id}
                  row={row}
                  canManage={canManage}
                  deleteAction={deleteAction}
                  pauseAction={pauseAction}
                  resumeAction={resumeAction}
                />
              ))}
            </ul>
          </DashboardFreshnessProvider>
        )}
      </PageContainer>
    </>
  );
}

function initialFreshness(
  rows: Array<{
    project: { id: string; pausedAt: Date | null };
    databases: DashboardDatabase[];
    cursor: { lastIndexedAt: Date | null; lastErrorAt: Date | null };
  }>,
): FreshnessInitial {
  return {
    projects: rows.map((row) => ({
      id: row.project.id,
      pausedAt: row.project.pausedAt,
      cursor: row.cursor,
      databases: row.databases.map((d) => ({
        name: d.name,
        lastQueryAt: d.lastQueryAt,
      })),
    })),
  };
}

// One project, rendered as a card. The whole card opens the project
// workspace (the name link's stretched ::after covers it); the inner deep
// links — the database / agents stats and each DB row — sit above it (z-10)
// so they route to their own pane. Rename / add-db / per-DB management all
// moved into the workspace: the list identifies and routes, the workspace
// manages. The "agents" stat doubles as the empty-state nudge — zero usable
// tokens means the endpoint is dark, so it reads "connect an agent →" in the
// warn tone instead of a dead "0".
function ProjectCard({
  row,
  canManage,
  deleteAction,
  pauseAction,
  resumeAction,
}: {
  row: DashboardProjectRow;
  canManage: boolean;
  deleteAction: (formData: FormData) => Promise<void>;
  pauseAction: (formData: FormData) => Promise<void>;
  resumeAction: (formData: FormData) => Promise<void>;
}) {
  const { project: c, databases, cursor, activeTokens } = row;
  const label = projectLabel(c);

  // Project-level "last query" = the most recent across its databases.
  // Server-rendered (the per-DB rows below carry the live values).
  const lastQueryAt = databases.reduce<Date | null>((max, d) => {
    if (!d.lastQueryAt) return max;
    return !max || d.lastQueryAt > max ? d.lastQueryAt : max;
  }, null);

  const statLabel =
    "font-mono text-[11px] lowercase tracking-[0.04em] transition-colors";
  // Clickable stat tile. relative z-10 lifts it above the card's stretched
  // open-link; the negative margins give it an 8×4px hit-padding without
  // shifting the row's rhythm; hover paints the --secondary surface (the
  // design system's hover fill) so the tile reads as a real target. radius
  // stays 0 per the spec-sheet aesthetic.
  const statTile =
    "group/stat relative z-10 -mx-2 -my-1 px-2 py-1 transition-colors hover:bg-secondary";

  return (
    <li className="group relative rounded-lg border border-border bg-card transition-colors hover:border-border-strong">
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link
              href={`/projects/${c.id}`}
              className="text-sm font-medium tracking-tight text-foreground after:absolute after:inset-0 focus-visible:underline focus-visible:outline-none"
            >
              {label}
            </Link>
            <div className="mt-1.5 flex items-center gap-3">
              <LiveProjectFreshness
                projectId={c.id}
                initialPausedAt={c.pausedAt}
                initialLastIndexedAt={cursor.lastIndexedAt}
                initialLastErrorAt={cursor.lastErrorAt}
              />
              {/* Pause/resume + the row menu (delete) are owner/admin only —
                  a member sees the freshness state but no management controls.
                  z-10 lifts the control above the card's stretched open-link
                  (::after inset-0) so clicking Pause/Resume doesn't navigate. */}
              {canManage && (
                <span className="relative z-10">
                  <ProjectServiceControl
                    projectId={c.id}
                    initialPausedAt={c.pausedAt}
                    pauseAction={pauseAction}
                    resumeAction={resumeAction}
                  />
                </span>
              )}
            </div>
          </div>
          <RegionBadge region={c.region} />
          {canManage && (
            <div className="relative z-10">
              <ProjectRowMenu
                id={c.id}
                name={c.name}
                deleteAction={deleteAction}
              />
            </div>
          )}
        </div>

        {/* Stat strip — deep links into the workspace's panes. Only the
            links carry z-10; the gaps between them fall through to the
            card's open-link. */}
        <div className="mt-4 flex flex-wrap items-start gap-x-10 gap-y-3">
          <Link
            href={`/projects/${c.id}?section=database`}
            className={statTile}
          >
            <div className="font-mono text-lg tabular-nums text-foreground">
              {databases.length}
            </div>
            <div
              className={cn(statLabel, "text-subtle group-hover/stat:text-foreground")}
            >
              {databases.length === 1 ? "database" : "databases"}
            </div>
          </Link>

          <Link
            href={`/projects/${c.id}?section=connect`}
            className={statTile}
          >
            <div
              className={cn(
                "font-mono text-lg tabular-nums",
                activeTokens > 0
                  ? "text-foreground"
                  : "text-[hsl(var(--warn))]",
              )}
            >
              {activeTokens}
            </div>
            <div
              className={cn(
                statLabel,
                activeTokens > 0
                  ? "text-subtle group-hover/stat:text-foreground"
                  : "text-[hsl(var(--warn))]",
              )}
            >
              {activeTokens === 0
                ? "connect an agent →"
                : `active ${activeTokens === 1 ? "agent" : "agents"}`}
            </div>
          </Link>

          {/* "queries" stat — always a deep-link to this project's audit
              log, even with zero queries (it just lands on the project-
              scoped audit view, empty or not — a valid "no activity yet"
              destination, not a dead stat). window=90d (the widest key) so it
              spans the project's full retained history; the audit page
              clamps it to the plan's retention. Without it /audit defaults to
              24h and a "last query" older than a day (this stat honors the
              plan's 7d/30d/90d retention) would land on an empty table. statTile's
              relative z-10 keeps the click off the card's stretched open-link. */}
          <Link
            href={`/audit?project=${c.id}&window=90d`}
            aria-label={`View ${label}'s queries in the audit log`}
            title={`View ${label}'s queries in the audit log`}
            className={statTile}
          >
            <div className="font-mono text-lg tabular-nums text-foreground">
              {lastQueryAt ? formatRelative(lastQueryAt) : "—"}
            </div>
            <div
              className={cn(
                statLabel,
                "flex items-center gap-1 text-subtle group-hover/stat:text-foreground",
              )}
            >
              {lastQueryAt ? "last query" : "no queries yet"}
              {/* Off-card target (the audit log) → flag with the mono → that
                  fades in on hover, the same "go" affordance buttons +
                  empty-state links use. */}
              <span
                aria-hidden
                className="font-mono opacity-0 transition-opacity group-hover/stat:opacity-100"
              >
                →
              </span>
            </div>
          </Link>
        </div>
      </div>

      {databases.length > 0 ? (
        <ul className="border-t border-border">
          {databases.map((db) => (
            <DatabaseRow
              key={db.id}
              projectId={c.id}
              // `db` is the safe projection from listDashboardProjects —
              // no encryptedDsn / kmsKeyId, so it crosses the RSC boundary
              // cleanly.
              database={db}
              initialLastQueryAt={db.lastQueryAt}
              initialPausedAt={c.pausedAt}
              initialLastIndexedAt={cursor.lastIndexedAt}
              initialLastErrorAt={cursor.lastErrorAt}
            />
          ))}
        </ul>
      ) : (
        <p className="relative z-10 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          No databases on this project yet.
        </p>
      )}
    </li>
  );
}

async function deleteAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");
  // Owner/admin only. The controls are hidden from members, so a throw here is
  // the tamper-path backstop (defense in depth).
  const { userId } = await assertManager();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("missing id");
  }
  const deleted = await deleteProject(customer, id);
  if (deleted) {
    const ctx = getMcpProxyContext();
    await ctx.registry.invalidate(deleted.id).catch((err) => {
      console.error("[dashboard.deleteAction] registry.invalidate failed", err);
    });
    if (userId) {
      getPostHog()?.capture({
        distinctId: userId,
        event: "project_deleted",
        properties: {
          project_id: deleted.id,
          region: customer.region,
          source: "dashboard",
        },
      });
    }
  }
  revalidatePath("/dashboard");
}

async function pauseAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");
  const { userId } = await assertManager();
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("missing id");
  }
  const result = await pauseProject(customer, id);
  if (!result) notFound();
  // Drop the running session — same teardown delete uses. Best-effort: the
  // pause is durable and the resolver rejects every request regardless.
  const ctx = getMcpProxyContext();
  await ctx.registry.invalidate(result.id).catch((err) => {
    console.error("[dashboard.pauseAction] registry.invalidate failed", err);
  });
  if (userId) {
    try {
      await emitConfigAuditRow(customer, {
        tenantId: result.id,
        database: "main",
        eventType: "PROJECT_PAUSED",
        payload: { project_id: result.id, action: "paused" },
        actorUserId: userId,
      });
    } catch (err) {
      console.error("[dashboard.pauseAction] PROJECT_PAUSED audit write failed", err);
    }
    getPostHog()?.capture({
      distinctId: userId,
      event: "project_paused",
      properties: {
        project_id: result.id,
        region: customer.region,
        source: "dashboard",
      },
    });
  }
  revalidatePath("/dashboard");
}

async function resumeAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");
  const { userId } = await assertManager();
  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("missing id");
  }
  const result = await resumeProject(customer, id);
  if (!result) notFound();
  // No teardown — the next agent request spawns a fresh engine with the
  // current policy.
  if (userId) {
    try {
      await emitConfigAuditRow(customer, {
        tenantId: result.id,
        database: "main",
        eventType: "PROJECT_RESUMED",
        payload: { project_id: result.id, action: "resumed" },
        actorUserId: userId,
      });
    } catch (err) {
      console.error("[dashboard.resumeAction] PROJECT_RESUMED audit write failed", err);
    }
    getPostHog()?.capture({
      distinctId: userId,
      event: "project_resumed",
      properties: {
        project_id: result.id,
        region: customer.region,
        source: "dashboard",
      },
    });
  }
  revalidatePath("/dashboard");
}
