import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { DeleteConnectionButton } from "@/components/delete-connection-button";
import { MaskedToken } from "@/components/masked-token";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import {
  deleteConnection,
  getConnectionWithMainDatabase,
} from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { getMcpProxyContext } from "@/lib/mcp-proxy";
import { REGION_LABELS } from "@/lib/region";

// Connection settings — small surface reached from the [⋯] menu on the
// dashboard. Holds the bits that don't deserve real estate on the live
// detail page: region (immutable), parent connection id, the masked
// mcp_token, and the delete-connection danger zone. Rename lives on the
// dashboard row; per-DB ops live on the detail page.

export default async function ConnectionSettings({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id } = await params;
  const result = await getConnectionWithMainDatabase(customer, id);
  if (!result) notFound();
  const { connection: conn } = result;

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
          "[connections/[id]/settings.deleteAction] registry.invalidate failed",
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
        <span className="font-mono">
          {conn.name ?? conn.id.slice(0, 12)}
        </span>
        <span className="mx-2 text-subtle">/</span>Settings
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title="Connection settings"
            subtitle="Region and identifiers for this MCP endpoint."
          />

          <section className="space-y-5 rounded-lg border border-border-strong bg-card p-6">
            <div className="space-y-2">
              <Label htmlFor="conn-region">Region</Label>
              <Input
                id="conn-region"
                readOnly
                value={REGION_LABELS[conn.region]}
              />
              <p className="text-xs text-muted-foreground">
                Set when the connection was created and not editable.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="conn-id">Connection ID</Label>
              <Input
                id="conn-id"
                readOnly
                value={conn.id}
                className="font-mono"
              />
            </div>

            <div className="space-y-2">
              <Label>MCP token</Label>
              <MaskedToken value={conn.mcpToken} />
              <p className="text-xs text-muted-foreground">
                Embedded in the MCP URL the agent uses; deleting the
                connection invalidates it.
              </p>
            </div>
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
