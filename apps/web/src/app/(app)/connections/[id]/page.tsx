import { ChevronRight, Database } from "lucide-react";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { type TableAccessPolicy } from "@midplane-cloud/db";
import { parseTenantScopeOrThrow } from "@midplane-cloud/db";

import { TestPolicyPanel } from "@/components/connections/test-policy-panel";
import { AddDatabaseForm } from "@/components/dashboard/add-database-form";
import { FreshnessDot } from "@/components/dashboard/freshness-dot";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { TokenList } from "@/components/tokens/token-list";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/ui/page-header";
import { RegionBadge } from "@/components/ui/region-badge";
import {
  getConnectionHomeData,
  getPlanUsage,
  type DashboardDatabase,
} from "@/lib/connections";
import { Button } from "@/components/ui/button";
import { currentCustomer } from "@/lib/customer";
import { addDatabaseFromForm } from "@/lib/database-form";
import { connectionLabel, lastQueryLabel } from "@/lib/format";
import { computeFreshness } from "@/lib/freshness";
import { resolvePlan, UPGRADE_URL } from "@/lib/plan";
import { accessLabel } from "@/lib/policy-labels";
import { listTokens } from "@/lib/tokens";

import { createTokenAction, revokeTokenAction } from "./token-actions";

// Connection home — everything about one connection on one page:
// databases (with add-database), token management, and the settings
// entry. Promoted from a tokens-only surface (PR3 of
// mcp_url_auth_security) per the connections-ux design doc: the page a
// connection's name leads to should answer "what can my agents reach,
// with which credentials, and is it healthy" without bouncing back to
// the list. The policy test panel (engine dry-run, OSS 0.8.0+) sits
// between databases and tokens; against an older engine image it
// degrades to a retryable engine_unavailable state.
//
// Per-DB settings (policy grid, DSN rotation) stay under
// /connections/[id]/databases/[name]; connection-scoped settings stay
// under /connections/[id]/settings.

export default async function ConnectionHome({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id } = await params;
  // One resolvePlan() read serves both consumers: auditRetentionDays
  // clamps the home's last-query facts, caps.tokens drives the
  // token-cap pre-flight below.
  const { plan, caps } = await resolvePlan();
  // The three reads below are independent of each other — only the
  // retention clamp depends on resolvePlan. Concurrent, not a waterfall.
  const [home, tokens, usage] = await Promise.all([
    getConnectionHomeData(customer, id, caps.auditRetentionDays),
    // listTokens returns null on unknown/foreign — the home check below
    // already gates ownership, but mirror the leakage shape if a race
    // deletes the connection between calls.
    listTokens(customer, id),
    // Pre-flight the token cap so "Connect an agent" reflects the limit
    // BEFORE the modal opens — same advisory-UX-over-authoritative-check
    // split as the connection create flow (createToken still enforces
    // under a row lock). The token cap is org-wide (all connections).
    getPlanUsage(customer),
  ]);
  if (!home) notFound();
  const { connection: conn, databases, cursor } = home;
  if (tokens === null) notFound();
  const tokenLimit =
    Number.isFinite(caps.tokens) && usage.tokens >= caps.tokens
      ? { limit: caps.tokens, plan, upgradeUrl: UPGRADE_URL }
      : undefined;

  const label = connectionLabel(conn);
  const freshness = computeFreshness(cursor);

  return (
    <>
      <Topbar>
        <Breadcrumb
          items={[
            { label: "Connections", href: "/dashboard" },
            { label },
          ]}
        />
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[920px]">
          <PageHeader
            title={
              <span className="flex items-center gap-2.5">
                {label}
                <FreshnessDot state={freshness} />
                <RegionBadge region={conn.region} />
              </span>
            }
            subtitle={
              <>
                This connection is a{" "}
                <strong className="font-medium text-foreground">
                  hosted MCP server
                </strong>
                . Each agent gets its own credentialed URL — paste it into
                Cursor, Claude Code, or any MCP client.
              </>
            }
            actions={
              // Button primitive, matching the dashboard's Open action —
              // a hand-rolled link here rendered square (rounded-md
              // collapses to 0) against the 6px button radius.
              <Link href={`/connections/${conn.id}/settings`}>
                <Button size="sm" variant="outline">
                  Settings
                </Button>
              </Link>
            }
          />

          <section
            className="space-y-3 rounded-lg border border-border bg-card p-6"
            data-testid="home-databases"
          >
            <div className="space-y-1">
              <h2 className="text-base font-medium text-foreground">
                Databases
              </h2>
              <p className="text-xs text-muted-foreground">
                Agents reach each database under its own{" "}
                <strong className="font-medium text-foreground">
                  per-table policy
                </strong>
                . Open one to edit permissions, tenant scoping, or rotate the
                credential.
              </p>
            </div>
            <div className="overflow-hidden rounded-md border border-border bg-background">
              <ul className="divide-y divide-border">
                {databases.map((db) => (
                  <HomeDatabaseRow
                    key={db.id}
                    connectionId={conn.id}
                    database={db}
                    freshness={freshness}
                  />
                ))}
              </ul>
              <AddDatabaseForm
                connectionId={conn.id}
                action={addDatabaseAction}
              />
            </div>
          </section>

          <div className="mt-6">
            <TestPolicyPanel
              connectionId={conn.id}
              databases={databases.map((db) => ({
                name: db.name,
                policyTables: Object.keys(
                  (db.tableAccess as TableAccessPolicy).tables ?? {},
                ),
                // Normalized server-side — the panel is a client
                // component and must not import the root db entrypoint.
                tenantScope: parseTenantScopeOrThrow(db.tenantScope),
              }))}
            />
          </div>

          <div className="mt-6">
            <TokenList
              connectionId={conn.id}
              connectionName={conn.name}
              region={conn.region}
              tokens={tokens}
              createAction={createTokenAction}
              revokeAction={revokeTokenAction}
              tokenLimit={tokenLimit}
            />
          </div>
        </div>
      </PageContainer>
    </>
  );
}

function HomeDatabaseRow({
  connectionId,
  database,
  freshness,
}: {
  connectionId: string;
  database: DashboardDatabase;
  freshness: ReturnType<typeof computeFreshness>;
}) {
  const policy = database.tableAccess as TableAccessPolicy;
  const tableCount = Object.keys(policy.tables ?? {}).length;
  const lastQueryText = lastQueryLabel(database.lastQueryAt); // shared copy

  return (
    <li>
      <Link
        href={`/connections/${connectionId}/databases/${database.name}`}
        className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
      >
        <FreshnessDot state={freshness} />
        <Database
          className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
          strokeWidth={1.5}
          aria-hidden
        />
        <span className="font-mono text-sm text-foreground">
          {database.name}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {accessLabel(policy.default)} · {tableCount}{" "}
          {tableCount === 1 ? "table" : "tables"} · {lastQueryText}
        </span>
        <ChevronRight
          className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
          strokeWidth={1.5}
          aria-hidden
        />
      </Link>
    </li>
  );
}

async function addDatabaseAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");

  // Shared body with the dashboard's action (lib/database-form.ts);
  // this action owns its revalidation surface only — including every
  // per-DB page, whose sibling strip changes with membership.
  const { connectionId } = await addDatabaseFromForm(customer, formData);
  revalidatePath(`/connections/${connectionId}`);
  revalidatePath("/dashboard");
  revalidatePath(`/connections/[id]/databases/[name]`, "page");
}
