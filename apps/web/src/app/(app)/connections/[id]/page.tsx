import { eq } from "drizzle-orm";
import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { connections, getDb, parsePolicyOrThrow } from "@midplane-cloud/db";
import { mintMcpUrl } from "@midplane-cloud/router";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyButton } from "@/components/copy-button";
import { DeleteConnectionButton } from "@/components/delete-connection-button";
import { EditableConnectionTitle } from "@/components/editable-connection-title";
import { PermissionGrid } from "@/components/permission-grid";
import { RotateConnectionForm } from "@/components/rotate-connection-form";
import {
  deleteConnection,
  isValidDsn,
  renameConnection,
  rotateConnection,
  setTableAccess,
} from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
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

  // Server Actions live alongside the page so the rotateConnection /
  // deleteConnection dependency closure is server-only — neither helper
  // touches client code paths.

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
    revalidatePath(`/connections/${formId}`);
    // The dashboard list also renders c.name, so its prefetched/cached
    // render goes stale on rename — bust it too.
    revalidatePath("/dashboard");
  }

  async function rotateAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");

    const formId = formData.get("id");
    const dsn = formData.get("dsn");
    if (typeof formId !== "string" || formId.length === 0) {
      throw new Error("missing id");
    }
    if (!isValidDsn(dsn)) {
      throw new Error("DSN must be a postgres:// or postgresql:// URL");
    }

    const ctx = getMcpProxyContext();
    const rotated = await rotateConnection(customer, formId, dsn, ctx);
    if (!rotated) {
      // 404-equivalent: the row exists for someone else, or doesn't exist.
      // We don't distinguish in the UI either — just bounce.
      notFound();
    }
    revalidatePath(`/connections/${formId}`);
  }

  async function policyAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");

    const formId = formData.get("id");
    if (typeof formId !== "string" || formId.length === 0) {
      throw new Error("missing id");
    }
    const raw = formData.get("policy");
    if (typeof raw !== "string") {
      throw new Error("missing policy");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("policy is not valid JSON");
    }
    // parsePolicyOrThrow runs the same validator as the spawner.
    const policy = parsePolicyOrThrow(parsed);

    const ctx = getMcpProxyContext();
    const result = await setTableAccess(customer, formId, policy, ctx);
    if (!result) notFound();
    revalidatePath(`/connections/${formId}`);
  }

  async function deleteAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");

    const formId = formData.get("id");
    if (typeof formId !== "string" || formId.length === 0) {
      throw new Error("missing id");
    }
    const deleted = await deleteConnection(customer, formId);
    if (deleted) {
      const ctx = getMcpProxyContext();
      await ctx.registry.invalidate(deleted.mcpToken).catch((err) => {
        console.error(
          "[connections/[id].deleteAction] registry.invalidate failed",
          err,
        );
      });
    }
    redirect("/dashboard");
  }

  return (
    <>
      <Topbar>
        <Link href="/dashboard">
          <b className="font-medium text-foreground">Connections</b>
        </Link>
        <span className="mx-2 text-subtle">/</span>
        <span className="font-mono">{conn.name ?? conn.id.slice(0, 12)}</span>
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <EditableConnectionTitle
            id={conn.id}
            initialName={conn.name}
            placeholder="Your MCP endpoint is ready"
            action={renameAction}
          />
          <p className="mt-2 text-sm text-muted-foreground">
            Hosted in {REGION_LABELS[conn.region]}. Your DSN is encrypted at
            rest; we never log or persist the plaintext.
          </p>

          <section className="mt-8 space-y-2">
            <Label htmlFor="mcp-url">MCP endpoint URL</Label>
            <div className="flex items-center gap-2">
              <Input
                id="mcp-url"
                readOnly
                value={mcpUrl}
                className="font-mono"
              />
              <CopyButton value={mcpUrl} />
            </div>
          </section>

          <section className="mt-8 space-y-2">
            <Label>Cursor config (~/.cursor/mcp.json)</Label>
            <div className="relative rounded-md border border-border bg-muted">
              <pre className="overflow-x-auto p-4 font-mono text-xs text-foreground">
                {cursorConfig}
              </pre>
              <div className="absolute right-2 top-2">
                <CopyButton value={cursorConfig} label="Copy config" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              For Claude Code:{" "}
              <code className="font-mono text-foreground">
                claude mcp add --transport http midplane {mcpUrl}
              </code>
            </p>
          </section>

          <section className="mt-12 space-y-3 rounded-lg border border-border bg-card p-6">
            <h2 className="text-base font-medium text-foreground">
              Table permissions
            </h2>
            <p className="text-xs text-muted-foreground">
              Per-table read / write policy enforced by the Midplane engine.
              Saving stops the running session so the new policy takes effect
              on the next agent request.
            </p>
            <div className="pt-2">
              <PermissionGrid
                connectionId={conn.id}
                initialPolicy={parsePolicyOrThrow(conn.tableAccess)}
                action={policyAction}
              />
            </div>
          </section>

          <section className="mt-6 space-y-3 rounded-lg border border-border bg-card p-6">
            <h2 className="text-base font-medium text-foreground">
              Rotate DSN
            </h2>
            <p className="text-xs text-muted-foreground">
              Paste a new Postgres URL to replace the encrypted ciphertext. The
              MCP endpoint URL stays the same; running sessions are torn down so
              the new credentials take effect on the next request.
              {conn.rotatedAt ? (
                <> Last rotated {formatRelative(conn.rotatedAt)}.</>
              ) : null}
            </p>
            <RotateConnectionForm id={conn.id} action={rotateAction} />
          </section>

          <section className="mt-6 flex items-center justify-between gap-4 rounded-lg border border-[hsl(var(--deny)/0.4)] bg-card p-6">
            <div>
              <h2 className="text-base font-medium text-foreground">
                Delete connection
              </h2>
              <p className="text-xs text-muted-foreground">
                Stops the MCP endpoint and removes the encrypted row. Audit
                history stays in the dashboard for compliance.
              </p>
            </div>
            <DeleteConnectionButton id={conn.id} action={deleteAction} />
          </section>

          <div className="mt-8">
            <Link href="/dashboard">
              <Button variant="outline">Back to dashboard</Button>
            </Link>
          </div>
        </div>
      </PageContainer>
    </>
  );
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
