import { auth } from "@clerk/nextjs/server";
import { Plus } from "lucide-react";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { ACCESS_LEVELS, type AccessLevel } from "@midplane-cloud/db/policy";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { AddDatabaseForm } from "@/components/dashboard/add-database-form";
import { ConnectionRowMenu } from "@/components/dashboard/connection-row-menu";
import { DatabaseRow } from "@/components/dashboard/database-row";
import {
  DashboardFreshnessProvider,
  type FreshnessInitial,
} from "@/components/dashboard/freshness-provider";
import { LiveConnectionFreshness } from "@/components/dashboard/live-connection-freshness";
import { RenameConnectionInline } from "@/components/dashboard/rename-connection-inline";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { type DashboardDatabase } from "@/lib/connections";
import {
  addDatabase,
  DatabaseNameTaken,
  deleteConnection,
  isValidDatabaseName,
  isValidDsn,
  LastDatabaseProtected,
  listDashboardConnections,
  removeDatabase,
  renameConnection,
  renameDatabase,
} from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { getPostHog } from "@/lib/posthog";

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

  const rows = await listDashboardConnections(customer);

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
            <ul className="divide-y divide-border border-y border-border">
              {rows.map((row) => {
                const { connection: c, databases, cursor } = row;
                return (
                  <li key={c.id} className="bg-background">
                    <ConnectionHeader
                      id={c.id}
                      name={c.name}
                      region={c.region}
                      initialLastIndexedAt={cursor.lastIndexedAt}
                      initialLastErrorAt={cursor.lastErrorAt}
                    />
                    <DatabaseList
                      connectionId={c.id}
                      databases={databases}
                      initialLastIndexedAt={cursor.lastIndexedAt}
                      initialLastErrorAt={cursor.lastErrorAt}
                    />
                  </li>
                );
              })}
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

function ConnectionHeader({
  id,
  name,
  region,
  initialLastIndexedAt,
  initialLastErrorAt,
}: {
  id: string;
  name: string | null;
  region: string;
  initialLastIndexedAt: Date | null;
  initialLastErrorAt: Date | null;
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
        <LiveConnectionFreshness
          connectionId={id}
          initialLastIndexedAt={initialLastIndexedAt}
          initialLastErrorAt={initialLastErrorAt}
        />
        <Link href={`/connections/${id}`}>
          <Button size="sm" variant="outline">
            Connect
          </Button>
        </Link>
        <ConnectionRowMenu id={id} name={name} deleteAction={deleteAction} />
      </div>
    </div>
  );
}

function DatabaseList({
  connectionId,
  databases,
  initialLastIndexedAt,
  initialLastErrorAt,
}: {
  connectionId: string;
  databases: DashboardDatabase[];
  initialLastIndexedAt: Date | null;
  initialLastErrorAt: Date | null;
}) {
  const disableRemove = databases.length <= 1;
  return (
    <div className="ml-4 mb-4 mt-1 overflow-hidden rounded-md border border-border bg-card">
      <ul className="divide-y divide-border">
        {databases.map((db) => (
          <DatabaseRow
            key={db.id}
            connectionId={connectionId}
            // `db` is the safe projection from listDashboardConnections —
            // no encryptedDsn / kmsKeyId, so it crosses the RSC boundary
            // cleanly.
            database={db}
            initialLastQueryAt={db.lastQueryAt}
            initialLastIndexedAt={initialLastIndexedAt}
            initialLastErrorAt={initialLastErrorAt}
            disableRemove={disableRemove}
            removeAction={removeDatabaseAction}
            renameAction={renameDatabaseAction}
          />
        ))}
      </ul>
      <AddDatabaseForm
        connectionId={connectionId}
        action={addDatabaseAction}
      />
    </div>
  );
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
  // Per-DB detail pages render conn.name in the topbar; settings renders
  // it in the topbar + delete-confirm label. Bust both. The bracketed
  // path revalidates every concrete /connections/[id]/databases/[name]
  // path under this connection without us having to enumerate them.
  revalidatePath(`/connections/[id]/databases/[name]`, "page");
  revalidatePath(`/connections/${formId}/settings`);
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

async function removeDatabaseAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");

  const connectionId = formData.get("connectionId");
  const dbName = formData.get("name");
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw new Error("missing connectionId");
  }
  if (typeof dbName !== "string" || dbName.length === 0) {
    throw new Error("missing name");
  }

  const ctx = getMcpProxyContext();
  try {
    const result = await removeDatabase(customer, connectionId, dbName, ctx);
    if (!result) notFound();
  } catch (err) {
    if (err instanceof LastDatabaseProtected) {
      throw new Error(
        "Can't remove the only database. Add another first or delete the connection.",
      );
    }
    throw err;
  }
  revalidatePath("/dashboard");
}

async function renameDatabaseAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");

  const connectionId = formData.get("connectionId");
  const oldName = formData.get("name");
  const newName = formData.get("newName");
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw new Error("missing connectionId");
  }
  if (typeof oldName !== "string" || oldName.length === 0) {
    throw new Error("missing name");
  }
  if (typeof newName !== "string" || !isValidDatabaseName(newName)) {
    throw new Error(
      "Name must be 1–32 lowercase letters / digits / _ - , starting with a letter.",
    );
  }

  const ctx = getMcpProxyContext();
  try {
    const result = await renameDatabase(
      customer,
      connectionId,
      oldName,
      newName,
      ctx,
    );
    if (!result) notFound();
  } catch (err) {
    if (err instanceof DatabaseNameTaken) {
      throw new Error(`A database named "${err.takenName}" already exists.`);
    }
    throw err;
  }
  revalidatePath("/dashboard");
  // Per-DB detail route lives at /databases/[name]; bust both old and new
  // so a stale cached instance under either path doesn't linger.
  revalidatePath(`/connections/[id]/databases/[name]`, "page");
}

async function addDatabaseAction(formData: FormData) {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/");

  const connectionId = formData.get("connectionId");
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw new Error("missing connectionId");
  }
  const nameRaw = formData.get("name");
  if (typeof nameRaw !== "string" || !isValidDatabaseName(nameRaw.trim())) {
    throw new Error(
      "Name must be 1–32 lowercase letters / digits / _ - , starting with a letter.",
    );
  }
  const dbName = nameRaw.trim();
  const dsn = formData.get("dsn");
  if (!isValidDsn(dsn)) {
    throw new Error("DSN must be a postgres:// or postgresql:// URL");
  }
  // The form posts a string; validate against the canonical enum so a
  // tampered request can't smuggle in something the spawner would
  // refuse. Missing field falls back to "read" — same posture as
  // createConnection.
  const accessRaw = formData.get("default_access");
  const defaultAccess: AccessLevel =
    typeof accessRaw === "string" &&
    (ACCESS_LEVELS as readonly string[]).includes(accessRaw)
      ? (accessRaw as AccessLevel)
      : "read";

  const ctx = getMcpProxyContext();
  try {
    const result = await addDatabase(
      customer,
      connectionId,
      dbName,
      dsn,
      defaultAccess,
      ctx,
    );
    if (!result) notFound();
  } catch (err) {
    if (err instanceof DatabaseNameTaken) {
      throw new Error(`A database named "${err.takenName}" already exists.`);
    }
    throw err;
  }
  revalidatePath("/dashboard");
}
