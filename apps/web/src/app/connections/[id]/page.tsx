import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { connections, getDb } from "@midplane-cloud/db";
import { mintMcpUrl } from "@midplane-cloud/router";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { currentCustomer } from "@/lib/customer";
import { REGION_LABELS } from "@/lib/region";

export default async function ConnectionDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id } = await params;
  const db = getDb();
  const rows = await db.select().from(connections).where(eq(connections.id, id));
  const conn = rows[0];
  if (!conn || conn.customerId !== customer.id) notFound();

  const mcpUrl = mintMcpUrl(conn.region, conn.mcpToken, process.env);
  const cursorConfig = JSON.stringify(
    { mcpServers: { midplane: { url: mcpUrl } } },
    null,
    2,
  );

  return (
    <main className="container mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Your MCP endpoint is ready
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Hosted in {REGION_LABELS[conn.region]}. Your DSN is encrypted at rest;
        we never log or persist the plaintext.
      </p>

      <section className="mt-8 space-y-2">
        <label className="text-sm font-medium">MCP endpoint URL</label>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={mcpUrl}
            className="flex h-10 w-full rounded-md border border-input bg-muted px-3 py-2 font-mono text-sm"
          />
          <CopyButton value={mcpUrl} />
        </div>
      </section>

      <section className="mt-8 space-y-2">
        <label className="text-sm font-medium">
          Cursor config (~/.cursor/mcp.json)
        </label>
        <div className="relative rounded-md border bg-muted">
          <pre className="overflow-x-auto p-4 font-mono text-xs">
            {cursorConfig}
          </pre>
          <div className="absolute right-2 top-2">
            <CopyButton value={cursorConfig} label="Copy config" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          For Claude Code:{" "}
          <code className="font-mono">
            claude mcp add --transport http midplane {mcpUrl}
          </code>
        </p>
      </section>

      <div className="mt-12">
        <Link href="/dashboard">
          <Button variant="outline">Back to dashboard</Button>
        </Link>
      </div>
    </main>
  );
}
