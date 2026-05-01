import { Database, Plus } from "lucide-react";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { type TableAccessPolicy } from "@midplane-cloud/db";
import { mintMcpUrl } from "@midplane-cloud/router";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { CopyButton } from "@/components/copy-button";
import { ConnectionRowMenu } from "@/components/dashboard/connection-row-menu";
import { FreshnessDot } from "@/components/dashboard/freshness-dot";
import { RenameConnectionInline } from "@/components/dashboard/rename-connection-inline";
import { SetupAgentControl } from "@/components/dashboard/setup-agent-control";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import {
  computeFreshness,
  FRESHNESS_LABELS,
  type Freshness,
} from "@/lib/freshness";
import {
  deleteConnection,
  listDashboardConnections,
  renameConnection,
} from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string | string[] }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const rows = await listDashboardConnections(customer);
  const setupParam = (await searchParams).setup;
  const autoOpenId = typeof setupParam === "string" ? setupParam : null;

  return (
    <>
      <Topbar>
        <b className="font-medium text-foreground">{customer.email}</b>
        <span className="mx-2 text-subtle">/</span>Connections
      </Topbar>
      <PageContainer>
        <PageHeader
          title="Connections"
          subtitle="Each connection is a hosted MCP endpoint with one or more databases. Point your agent at the URL; Midplane proxies its calls to the database under your access policy."
          actions={
            <Link href="/connections/new">
              <Button size="sm">
                <Plus className="mr-1 h-3.5 w-3.5" strokeWidth={1.5} />
                New connection
              </Button>
            </Link>
          }
        />

        {rows.length === 0 ? (
          <EmptyState
            title="No connections yet"
            description="Add a Postgres connection to get a hosted MCP endpoint."
            action={
              <Link href="/connections/new">
                <Button size="sm">Connect Postgres</Button>
              </Link>
            }
          />
        ) : (
          <ul className="divide-y divide-border border-y border-border">
            {rows.map((row) => {
              const { connection: c, mainDatabase: db, cursor } = row;
              const freshness = computeFreshness({
                lastIndexedAt: cursor.lastIndexedAt,
                lastErrorAt: cursor.lastErrorAt,
              });
              const mcpUrl = mintMcpUrl(c.region, c.mcpToken, process.env);
              const policy = db.tableAccess as TableAccessPolicy;
              const tableCount = Object.keys(policy.tables ?? {}).length;
              return (
                <li key={c.id} className="bg-background">
                  <ConnectionHeader
                    id={c.id}
                    name={c.name}
                    region={c.region}
                    freshness={freshness}
                    mcpUrl={mcpUrl}
                    mcpToken={c.mcpToken}
                    autoOpen={autoOpenId === c.id}
                  />
                  <DatabaseList
                    connectionId={c.id}
                    dbName={db.name}
                    defaultAccess={policy.default}
                    tableCount={tableCount}
                    lastQueryAt={cursor.lastIndexedAt}
                    freshness={freshness}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </PageContainer>
    </>
  );
}

function ConnectionHeader({
  id,
  name,
  region,
  freshness,
  mcpUrl,
  mcpToken,
  autoOpen,
}: {
  id: string;
  name: string | null;
  region: string;
  freshness: Freshness;
  mcpUrl: string;
  mcpToken: string;
  autoOpen: boolean;
}) {
  return (
    <div className="px-1 pt-4 pb-2">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <RenameConnectionInline
            id={id}
            initialName={name}
            placeholder="Untitled connection"
            action={renameAction}
          />
        </div>
        <span className="font-mono text-[11px] uppercase tracking-[0.04em] text-subtle">
          {region}
        </span>
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.04em] text-subtle">
          <FreshnessDot state={freshness} />
          {FRESHNESS_LABELS[freshness]}
        </span>
        <ConnectionRowMenu id={id} name={name} deleteAction={deleteAction} />
        <SetupAgentControl
          connectionName={name}
          mcpUrl={mcpUrl}
          mcpToken={mcpToken}
          autoOpen={autoOpen}
        />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="truncate font-mono text-xs text-muted-foreground">
          {mcpUrl}
        </span>
        <CopyButton value={mcpUrl} label="Copy URL" />
      </div>
    </div>
  );
}

function DatabaseList({
  connectionId,
  dbName,
  defaultAccess,
  tableCount,
  lastQueryAt,
  freshness,
}: {
  connectionId: string;
  dbName: string;
  defaultAccess: string;
  tableCount: number;
  lastQueryAt: Date | null;
  freshness: Freshness;
}) {
  return (
    <div className="ml-4 mb-4 mt-1 overflow-hidden rounded-md border border-border bg-card">
      <Link
        href={`/connections/${connectionId}`}
        className="flex min-h-[44px] items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
      >
        <FreshnessDot state={freshness} />
        <Database
          className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
          strokeWidth={1.5}
          aria-hidden
        />
        <span className="font-mono text-sm text-foreground">{dbName}</span>
        <span className="ml-auto text-xs text-muted-foreground">
          {accessLabel(defaultAccess)} · {tableCount}{" "}
          {tableCount === 1 ? "table" : "tables"} · {lastQueryLabel(lastQueryAt)}
        </span>
      </Link>
      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          disabled
          title="Multi-database support is coming in the next release"
          className="inline-flex items-center gap-1.5 text-xs text-subtle disabled:cursor-not-allowed"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          Add database to this connection
          <span className="ml-1 rounded-sm border border-border px-1 text-[10px] uppercase tracking-[0.04em]">
            soon
          </span>
        </button>
      </div>
    </div>
  );
}

function accessLabel(level: string): string {
  if (level === "read") return "read";
  if (level === "deny") return "deny";
  if (level === "read_write") return "read · write";
  return level;
}

function lastQueryLabel(lastIndexedAt: Date | null): string {
  if (!lastIndexedAt) return "awaiting first query";
  return `last query ${formatRelative(lastIndexedAt)}`;
}

function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

async function renameAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");

  const formId = formData.get("id");
  if (typeof formId !== "string" || formId.length === 0) {
    throw new Error("missing id");
  }
  const nameRaw = formData.get("name");
  const name = typeof nameRaw === "string" ? nameRaw : null;

  const renamed = await renameConnection(customer, formId, name);
  if (!renamed) notFound();
  revalidatePath("/dashboard");
  // Detail page renders conn.name in the title and topbar; settings page
  // renders it in the topbar + delete-confirm label. Both go stale on
  // rename if they were prefetched or recently visited — bust both.
  revalidatePath(`/connections/${formId}`);
  revalidatePath(`/connections/${formId}/settings`);
}

async function deleteAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");

  const id = formData.get("id");
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("missing id");
  }
  const deleted = await deleteConnection(customer, id);
  if (deleted) {
    const ctx = getMcpProxyContext();
    await ctx.registry.invalidate(deleted.mcpToken).catch((err) => {
      console.error("[dashboard.deleteAction] registry.invalidate failed", err);
    });
  }
  revalidatePath("/dashboard");
}
