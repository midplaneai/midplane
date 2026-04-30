import { UserButton } from "@clerk/nextjs";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { connections, getDb } from "@midplane-cloud/db";
import { mintMcpUrl } from "@midplane-cloud/router";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { DeleteConnectionButton } from "@/components/delete-connection-button";
import { deleteConnection } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { REGION_LABELS } from "@/lib/region";

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
    <main className="container mx-auto max-w-4xl px-4 py-12">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Midplane</h1>
          <p className="text-sm text-muted-foreground">
            {customer.email} · {REGION_LABELS[customer.region]}
          </p>
        </div>
        <UserButton afterSignOutUrl="/" />
      </header>

      <section className="mt-12 flex items-center justify-between">
        <h2 className="text-lg font-medium">Connections</h2>
        <Link href="/connections/new">
          <Button size="sm">New connection</Button>
        </Link>
      </section>

      {rows.length === 0 ? (
        <div className="mt-4 flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed bg-card/50 p-12 text-center">
          <p className="text-lg font-medium">No connections yet</p>
          <p className="text-sm text-muted-foreground">
            Add a Postgres connection to get a hosted MCP endpoint.
          </p>
          <Link href="/connections/new">
            <Button>Connect Postgres</Button>
          </Link>
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((c) => {
            const mcpUrl = mintMcpUrl(c.region, c.mcpToken, process.env);
            return (
              <li
                key={c.id}
                className="flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <Link
                    href={`/connections/${c.id}`}
                    className="block truncate text-sm font-medium hover:underline"
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
                  <p className="text-xs text-muted-foreground">
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
    </main>
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
