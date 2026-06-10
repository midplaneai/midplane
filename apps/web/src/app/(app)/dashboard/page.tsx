import { auth } from "@clerk/nextjs/server";
import { Plus } from "lucide-react";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { ConnectionRowMenu } from "@/components/dashboard/connection-row-menu";
import { DatabaseRow } from "@/components/dashboard/database-row";
import {
  DashboardFreshnessProvider,
  type FreshnessInitial,
} from "@/components/dashboard/freshness-provider";
import { LiveConnectionFreshness } from "@/components/dashboard/live-connection-freshness";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { RegionBadge } from "@/components/ui/region-badge";
import {
  type DashboardConnectionRow,
  type DashboardDatabase,
  deleteConnection,
  listDashboardConnections,
} from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { connectionLabel, formatRelative } from "@/lib/format";
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
  if (!customer) redirect("/signup/region");

  // PR1's create flow redirected to /dashboard?setup=<id> to auto-open
  // the agent setup sheet. PR2 routes new connections through the
  // dedicated /connections/<id>/created success page instead. Strip
  // the stale param if a bookmarked URL still carries it.
  void searchParams;

  const { caps } = await resolvePlan();
  const rows = await listDashboardConnections(
    customer,
    caps.auditRetentionDays,
  );

  // Surface the connection cap in the header so the limit is visible before
  // the user tries to add one (and the create form already guards the same
  // cap on /connections/new). Unlimited (Team) shows no counter. atLimit
  // only fires when rows is non-empty, so it never collides with the
  // empty-state branch below.
  const connectionLimit = caps.connections;
  const atConnectionLimit =
    Number.isFinite(connectionLimit) && rows.length >= connectionLimit;

  return (
    <>
      <Topbar>
        <Breadcrumb items={[{ label: "Connections" }]} />
      </Topbar>
      <PageContainer>
        <PageHeader
          title="Connections"
          subtitle={
            <>
              Each connection is a{" "}
              <strong className="font-medium text-foreground">
                hosted MCP endpoint
              </strong>{" "}
              with one or more databases. Point your agent at the URL; Midplane
              proxies its calls to the database under your access policy.
            </>
          }
          actions={
            <div className="flex items-center gap-3">
              {Number.isFinite(connectionLimit) ? (
                <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-subtle">
                  {rows.length} / {connectionLimit}
                </span>
              ) : null}
              {atConnectionLimit ? (
                <Link href={UPGRADE_URL}>
                  <Button size="sm" variant="outline">
                    Upgrade to add more
                  </Button>
                </Link>
              ) : (
                <Link href="/connections/new">
                  <Button size="sm">
                    <Plus className="mr-1 h-3.5 w-3.5" strokeWidth={1.5} />
                    New connection
                  </Button>
                </Link>
              )}
            </div>
          }
        />

        {rows.length === 0 ? (
          <EmptyState
            title="No connections yet"
            description={
              <>
                Add a Postgres connection to get a{" "}
                <strong className="font-medium text-foreground">
                  hosted MCP endpoint
                </strong>
                .
              </>
            }
            action={
              <Link href="/connections/new">
                <Button size="sm">Connect Postgres</Button>
              </Link>
            }
          />
        ) : (
          <DashboardFreshnessProvider initial={initialFreshness(rows)}>
            <ul className="space-y-3">
              {rows.map((row) => (
                <ConnectionCard
                  key={row.connection.id}
                  row={row}
                  deleteAction={deleteAction}
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
    connection: { id: string };
    databases: DashboardDatabase[];
    cursor: { lastIndexedAt: Date | null; lastErrorAt: Date | null };
  }>,
): FreshnessInitial {
  return {
    connections: rows.map((row) => ({
      id: row.connection.id,
      cursor: row.cursor,
      databases: row.databases.map((d) => ({
        name: d.name,
        lastQueryAt: d.lastQueryAt,
      })),
    })),
  };
}

// One connection, rendered as a card. The whole card opens the connection
// workspace (the name link's stretched ::after covers it); the inner deep
// links — the database / agents stats and each DB row — sit above it (z-10)
// so they route to their own pane. Rename / add-db / per-DB management all
// moved into the workspace: the list identifies and routes, the workspace
// manages. The "agents" stat doubles as the empty-state nudge — zero usable
// tokens means the endpoint is dark, so it reads "connect an agent →" in the
// warn tone instead of a dead "0".
function ConnectionCard({
  row,
  deleteAction,
}: {
  row: DashboardConnectionRow;
  deleteAction: (formData: FormData) => Promise<void>;
}) {
  const { connection: c, databases, cursor, activeTokens } = row;
  const label = connectionLabel(c);

  // Connection-level "last query" = the most recent across its databases.
  // Server-rendered (the per-DB rows below carry the live values).
  const lastQueryAt = databases.reduce<Date | null>((max, d) => {
    if (!d.lastQueryAt) return max;
    return !max || d.lastQueryAt > max ? d.lastQueryAt : max;
  }, null);

  const statLabel =
    "font-mono text-[11px] lowercase tracking-[0.04em] transition-colors";

  return (
    <li className="group relative rounded-lg border border-border bg-card transition-colors hover:border-border-strong">
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <Link
              href={`/connections/${c.id}`}
              className="text-sm font-medium tracking-tight text-foreground after:absolute after:inset-0 focus-visible:underline focus-visible:outline-none"
            >
              {label}
            </Link>
            <div className="mt-1.5">
              <LiveConnectionFreshness
                connectionId={c.id}
                initialLastIndexedAt={cursor.lastIndexedAt}
                initialLastErrorAt={cursor.lastErrorAt}
              />
            </div>
          </div>
          <RegionBadge region={c.region} />
          <div className="relative z-10">
            <ConnectionRowMenu
              id={c.id}
              name={c.name}
              deleteAction={deleteAction}
            />
          </div>
        </div>

        {/* Stat strip — deep links into the workspace's panes. Only the
            links carry z-10; the gaps between them fall through to the
            card's open-link. */}
        <div className="mt-4 flex flex-wrap items-start gap-x-10 gap-y-3">
          <Link
            href={`/connections/${c.id}?section=database`}
            className="group/stat relative z-10"
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
            href={`/connections/${c.id}?section=agents`}
            className="group/stat relative z-10"
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

          <div>
            <div className="font-mono text-lg tabular-nums text-foreground">
              {lastQueryAt ? formatRelative(lastQueryAt) : "—"}
            </div>
            <div className={cn(statLabel, "text-subtle")}>
              {lastQueryAt ? "last query" : "no queries yet"}
            </div>
          </div>
        </div>
      </div>

      {databases.length > 0 ? (
        <ul className="border-t border-border">
          {databases.map((db) => (
            <DatabaseRow
              key={db.id}
              connectionId={c.id}
              // `db` is the safe projection from listDashboardConnections —
              // no encryptedDsn / kmsKeyId, so it crosses the RSC boundary
              // cleanly.
              database={db}
              initialLastQueryAt={db.lastQueryAt}
              initialLastIndexedAt={cursor.lastIndexedAt}
              initialLastErrorAt={cursor.lastErrorAt}
            />
          ))}
        </ul>
      ) : (
        <p className="relative z-10 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          No databases on this connection yet.
        </p>
      )}
    </li>
  );
}

async function deleteAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");
  const { userId } = await auth();

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("missing id");
  }
  const deleted = await deleteConnection(customer, id);
  if (deleted) {
    const ctx = getMcpProxyContext();
    await ctx.registry.invalidate(deleted.id).catch((err) => {
      console.error("[dashboard.deleteAction] registry.invalidate failed", err);
    });
    if (userId) {
      getPostHog()?.capture({
        distinctId: userId,
        event: "connection_deleted",
        properties: {
          connection_id: deleted.id,
          region: customer.region,
          source: "dashboard",
        },
      });
    }
  }
  revalidatePath("/dashboard");
}
