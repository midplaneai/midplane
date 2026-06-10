import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";

import {
  parsePolicyOrThrow,
  parseTenantScopeOrThrow,
} from "@midplane-cloud/db";

import { PageContainer } from "@/components/layout/app-shell";
import { connectionLabel, formatRelative } from "@/lib/format";
import { PermissionGrid } from "@/components/permission-grid";
import { RotateConnectionForm } from "@/components/rotate-connection-form";
import { TenantScopeEditor } from "@/components/tenant-scope-editor";
import { TestReachabilityButton } from "@/components/connections/test-reachability-button";
import { PageHeader } from "@/components/ui/page-header";
import {
  getConnectionWithDatabase,
  getConnectionWithDatabaseAndCredential,
  isValidDsn,
  rotateConnection,
  setTableAccess,
  setTenantScope,
} from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { pingDsnGuarded } from "@/lib/ping-guard";
import { getPostHog } from "@/lib/posthog";
import {
  checkRateLimit,
  PING_TEST_RATE_LIMIT,
  pingTestKey,
} from "@/lib/rate-limit";

// Per-DB detail page. The hierarchical dashboard owns the connection-level
// surface (rename, delete, agent setup, MCP URL); this route is scoped to
// one DB on that connection — its policy grid + DSN rotation. Keep the
// page lean: anything that's connection-scoped lives on the dashboard or
// /connections/[id]/settings, never here.
//
// Server actions close over `id` and `name` from the URL params instead of
// re-reading them from formData — the URL is the authoritative resource
// reference, and a tampered hidden field shouldn't redirect a write to
// a different DB.

export default async function DatabaseDetail({
  params,
}: {
  params: Promise<{ id: string; name: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id, name } = await params;
  const result = await getConnectionWithDatabase(customer, id, name);
  if (!result) notFound();
  const { connection: conn, database: db } = result;

  async function rotateAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    const { userId } = await auth();

    const dsn = formData.get("dsn");
    if (!isValidDsn(dsn)) {
      throw new Error("DSN must be a postgres:// or postgresql:// URL");
    }

    const ctx = getMcpProxyContext();
    const rotated = await rotateConnection(customer, id, dsn, ctx, name);
    if (!rotated) notFound();
    revalidatePath(`/connections/${id}/databases/${name}`);

    if (userId) {
      getPostHog()?.capture({
        distinctId: userId,
        event: "connection_rotated",
        properties: {
          connection_id: rotated.id,
          region: customer.region,
          source: "dashboard",
        },
      });
    }
  }

  async function policyAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    // Clerk user id stamps the POLICY_CHANGED audit row's actor — answers
    // "who changed the policy?" in the audit log.
    const { userId } = await auth();
    if (!userId) redirect("/");

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
    const result = await setTableAccess(customer, id, policy, ctx, userId, name);
    if (!result) notFound();
    revalidatePath(`/connections/${id}/databases/${name}`);
  }

  async function testReachabilityAction(): Promise<{
    ok: boolean;
    error?: string;
  }> {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");

    // Same per-customer budget as the pasted-DSN testers — switching
    // surfaces doesn't reset the window (lib/rate-limit.ts owns it).
    const limited = checkRateLimit(
      pingTestKey(customer.id),
      PING_TEST_RATE_LIMIT,
    );
    if (!limited.ok) {
      return { ok: false, error: "too many tests — try again shortly" };
    }

    const result = await getConnectionWithDatabaseAndCredential(
      customer,
      id,
      name,
    );
    if (!result) notFound();

    const ctx = getMcpProxyContext();
    const decrypt = await ctx.resolver.resolve({
      connectionDatabase: result.database,
      region: result.connection.region,
      customerId: result.connection.customerId,
    });
    if (!decrypt.ok) {
      return {
        ok: false,
        error:
          "credential unavailable — try again, or rotate the connection string",
      };
    }
    // Guarded even though the DSN came from our own row: it was only
    // regex-validated at creation, so stored DSNs are not implicitly
    // trusted with internal dials either.
    return pingDsnGuarded(decrypt.plaintext);
  }

  async function scopeAction(formData: FormData) {
    "use server";
    const customer = await currentCustomer();
    if (!customer) redirect("/");
    // Clerk user id stamps the TENANT_SCOPE_CHANGED audit row's actor.
    const { userId } = await auth();
    if (!userId) redirect("/");

    const raw = formData.get("config");
    if (typeof raw !== "string") {
      throw new Error("missing config");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("config is not valid JSON");
    }
    // parseTenantScopeOrThrow gives a single throw-point for shape
    // errors; setTenantScope re-validates the same shape before any DB
    // work as defense-in-depth.
    const config = parseTenantScopeOrThrow(parsed);

    const ctx = getMcpProxyContext();
    const result = await setTenantScope(customer, id, config, ctx, userId, name);
    if (!result) notFound();
    revalidatePath(`/connections/${id}/databases/${name}`);
  }

  const label = connectionLabel(conn);

  // Topbar (breadcrumb) + the sibling-db context strip are owned by the
  // nested layout one level up (databases/[name]/layout.tsx) — this page
  // renders content only.
  return (
    <>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title={
              <span className="flex items-baseline gap-2">
                <span className="font-mono text-foreground">{db.name}</span>
                <span className="text-sm font-normal text-muted-foreground">
                  on {label}
                </span>
              </span>
            }
            subtitle="Per-table access policy and the encrypted Postgres credential."
          />

          <section className="space-y-3 rounded-none border border-border-strong bg-card p-6">
            <h2 className="text-base font-medium text-foreground">
              Table permissions
            </h2>
            <p className="text-xs text-muted-foreground">
              Per-table read / write policy enforced by the Midplane engine.{" "}
              <strong className="font-medium text-foreground">
                Saving stops the running session
              </strong>{" "}
              so the new policy takes effect on the next agent request.
            </p>
            <div className="pt-2">
              <PermissionGrid
                connectionId={conn.id}
                dbName={db.name}
                initialPolicy={parsePolicyOrThrow(db.tableAccess)}
                action={policyAction}
              />
            </div>
          </section>

          <section className="mt-6 space-y-3 rounded-none border border-border-strong bg-card p-6">
            <h2 className="text-base font-medium text-foreground">
              Tenant scoping
            </h2>
            <p className="text-xs text-muted-foreground">
              Force agent queries to only see rows belonging to one tenant.
              Set the default tenant column once; every queried table is{" "}
              <strong className="font-medium text-foreground">
                automatically scoped on it
              </strong>
              . List exceptions for tables that use a different column or that
              are intentionally shared across tenants.
            </p>
            <div className="pt-2">
              <TenantScopeEditor
                connectionId={conn.id}
                initialConfig={parseTenantScopeOrThrow(db.tenantScope)}
                action={scopeAction}
              />
            </div>
          </section>

          <section className="mt-6 space-y-3 rounded-none border border-border-strong bg-card p-6">
            <h2 className="text-base font-medium text-foreground">
              Test reachability
            </h2>
            <p className="text-xs text-muted-foreground">
              Opens one connection from the cloud using the stored credential
              and runs{" "}
              <strong className="font-medium text-foreground">SELECT 1</strong>
              . Nothing is persisted and the running session is untouched.
            </p>
            <TestReachabilityButton action={testReachabilityAction} />
          </section>

          <section className="mt-6 space-y-3 rounded-none border border-border-strong bg-card p-6">
            <h2 className="text-base font-medium text-foreground">
              Rotate connection string
            </h2>
            <p className="text-xs text-muted-foreground">
              Paste a new Postgres URL to replace the encrypted ciphertext.{" "}
              <strong className="font-medium text-foreground">
                The MCP endpoint URL stays the same
              </strong>
              ; running sessions are torn down so the new credentials take
              effect on the next request.
              {db.rotatedAt ? (
                <> Last rotated {formatRelative(db.rotatedAt)}.</>
              ) : null}
            </p>
            <RotateConnectionForm id={conn.id} action={rotateAction} />
          </section>
        </div>
      </PageContainer>
    </>
  );
}

