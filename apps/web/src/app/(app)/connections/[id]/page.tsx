import Link from "next/link";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import { parsePolicyOrThrow } from "@midplane-cloud/db";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { PermissionGrid } from "@/components/permission-grid";
import { RotateConnectionForm } from "@/components/rotate-connection-form";
import { PageHeader } from "@/components/ui/page-header";
import {
  getConnectionWithMainDatabase,
  isValidDsn,
  rotateConnection,
  setTableAccess,
} from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";

// PR-B: this page now hosts only the DB-level surface. MCP URL + agent
// config moved into the side sheet; rename + delete + region moved into
// the settings page. PR-C will rename this route to
// /connections/[id]/databases/[name] and add the per-DB list.

export default async function ConnectionDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id } = await params;
  const result = await getConnectionWithMainDatabase(customer, id);
  if (!result) notFound();
  const { connection: conn, mainDatabase: mainDb } = result;

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
    const policy = parsePolicyOrThrow(parsed);

    const ctx = getMcpProxyContext();
    const result = await setTableAccess(customer, formId, policy, ctx);
    if (!result) notFound();
    revalidatePath(`/connections/${formId}`);
  }

  const connectionLabel = conn.name ?? conn.id.slice(0, 12);

  return (
    <>
      <Topbar>
        <Link href="/dashboard">
          <b className="font-medium text-foreground">Connections</b>
        </Link>
        <span className="mx-2 text-subtle">/</span>
        <span className="font-mono">{connectionLabel}</span>
        <span className="mx-2 text-subtle">/</span>
        <span className="font-mono">{mainDb.name}</span>
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title={
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-foreground">{mainDb.name}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  on {connectionLabel}
                </span>
              </span>
            }
            subtitle="Per-table access policy and the encrypted Postgres credential."
          />

          <section className="space-y-3 rounded-lg border border-border-strong bg-card p-6">
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
              MCP endpoint URL stays the same; running sessions are torn down
              so the new credentials take effect on the next request.
              {mainDb.rotatedAt ? (
                <> Last rotated {formatRelative(mainDb.rotatedAt)}.</>
              ) : null}
            </p>
            <RotateConnectionForm id={conn.id} action={rotateAction} />
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
