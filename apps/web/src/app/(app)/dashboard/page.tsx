import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { connections, getDb } from "@midplane-cloud/db";
import { mintMcpUrl } from "@midplane-cloud/router";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { CopyButton } from "@/components/copy-button";
import { DeleteConnectionButton } from "@/components/delete-connection-button";
import { deleteConnection } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";

export default async function Dashboard() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const db = getDb();
  const rows = await db
    .select()
    .from(connections)
    .where(eq(connections.customerId, customer.id))
    .orderBy(desc(connections.createdAt));

  return (
    <>
      <Topbar>
        <b className="font-medium text-foreground">{customer.email}</b>
        <span className="mx-2 text-subtle">/</span>Connections
      </Topbar>
      <PageContainer>
        <PageHeader
          title="Connections"
          actions={
            <Link href="/connections/new">
              <Button size="sm">New connection</Button>
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
          <ul className="space-y-2">
            {rows.map((c) => {
              const mcpUrl = mintMcpUrl(c.region, c.mcpToken, process.env);
              return (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link
                      href={`/connections/${c.id}`}
                      className="block truncate text-sm font-medium text-foreground hover:underline"
                    >
                      {c.name ?? (
                        <span className="font-mono text-muted-foreground">
                          {mcpUrl}
                        </span>
                      )}
                    </Link>
                    {c.name ? (
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {mcpUrl}
                      </p>
                    ) : null}
                    <p className="text-xs text-subtle">
                      Created {formatRelative(c.createdAt)}
                    </p>
                  </div>
                  <CopyButton value={mcpUrl} />
                  <DeleteConnectionButton id={c.id} action={deleteAction} />
                </li>
              );
            })}
          </ul>
        )}
      </PageContainer>
    </>
  );
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
    // Stop the running OSS container — it still holds the deleted DSN in
    // env until the 30-min idle timer fires otherwise.
    const ctx = getMcpProxyContext();
    await ctx.registry.invalidate(deleted.mcpToken).catch((err) => {
      console.error("[dashboard.deleteAction] registry.invalidate failed", err);
    });
  }
  revalidatePath("/dashboard");
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
