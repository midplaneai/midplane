import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { parsePolicyOrThrow } from "@midplane-cloud/db";
import { mintMcpUrl } from "@midplane-cloud/router";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { ClientConfigTabs } from "@/components/client-config-tabs";
import { CopyButton } from "@/components/copy-button";
import { DeleteConnectionButton } from "@/components/delete-connection-button";
import { EditableConnectionTitle } from "@/components/editable-connection-title";
import { PermissionGrid } from "@/components/permission-grid";
import { RotateConnectionForm } from "@/components/rotate-connection-form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteConnection,
  getConnectionWithMainDatabase,
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
  // Multi-DB rollout (0008): credentials/policy moved to connection_databases.
  // PR-A keeps this page single-DB-shaped; it reads parent + the "main"
  // child and surfaces the child's table_access + rotated_at as before.
  // PR-B/C extend this page with a per-DB tab strip.
  const result = await getConnectionWithMainDatabase(customer, id);
  if (!result) notFound();
  const { connection: conn, mainDatabase: mainDb } = result;

  const mcpUrl = mintMcpUrl(conn.region, conn.mcpToken, process.env);

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
            Hosted in {REGION_LABELS[conn.region]}. Your Postgres connection
            string is encrypted at rest; we never log or persist the plaintext.
          </p>

          <section className="mt-8 space-y-5 rounded-lg border border-border-strong bg-card p-6">
            <div>
              <h2 className="text-base font-medium text-foreground">
                Connect your client
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Point any MCP-aware tool at the Midplane endpoint below.
              </p>
            </div>

            <div className="space-y-2">
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
            </div>

            <ClientConfigTabs mcpUrl={mcpUrl} />
          </section>

          <section className="mt-6 space-y-3 rounded-lg border border-border-strong bg-card p-6">
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
                initialPolicy={parsePolicyOrThrow(mainDb.tableAccess)}
                action={policyAction}
              />
            </div>
          </section>

          <section className="mt-6 space-y-3 rounded-lg border border-border-strong bg-card p-6">
            <h2 className="text-base font-medium text-foreground">
              Rotate connection string
            </h2>
            <p className="text-xs text-muted-foreground">
              Paste a new Postgres URL to replace the encrypted ciphertext. The
              MCP endpoint URL stays the same; running sessions are torn down so
              the new credentials take effect on the next request.
              {mainDb.rotatedAt ? (
                <> Last rotated {formatRelative(mainDb.rotatedAt)}.</>
              ) : null}
            </p>
            <RotateConnectionForm id={conn.id} action={rotateAction} />
          </section>

          <section className="mt-6 space-y-3 rounded-lg border border-[hsl(var(--deny)/0.4)] bg-card p-6">
            <h2 className="text-base font-medium text-foreground">
              Delete connection
            </h2>
            <p className="text-xs text-muted-foreground">
              Stops the MCP endpoint and removes the encrypted row. Audit
              history stays in the dashboard for compliance.
            </p>
            <DeleteConnectionButton id={conn.id} action={deleteAction} />
          </section>
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
