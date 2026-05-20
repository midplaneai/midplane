import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { TokenList } from "@/components/tokens/token-list";
import { PageHeader } from "@/components/ui/page-header";
import { getConnectionWithMainDatabase } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { listTokens } from "@/lib/tokens";

import { createTokenAction, revokeTokenAction } from "./token-actions";

// Connection detail page — the home of token management (PR3 of
// mcp_url_auth_security). Renders the Tokens section; future iterations
// add other connection-scoped surfaces here (audit token-filtered view,
// usage charts). Per-DB settings (policy grid, DSN rotation) stay under
// /connections/[id]/databases/[name], and connection-scoped settings
// stay under /connections/[id]/settings.

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
  const { connection: conn } = result;

  // listTokens returns null on unknown/foreign — the parent check above
  // already gates ownership, but mirror the leakage shape if a race
  // deletes the connection between calls.
  const tokens = await listTokens(customer, id);
  if (tokens === null) notFound();

  const connectionLabel = conn.name ?? conn.id.slice(0, 12);

  return (
    <>
      <Topbar>
        <Link href="/dashboard">
          <b className="font-medium text-foreground">Connections</b>
        </Link>
        <span className="mx-2 text-subtle">/</span>
        <span className="font-mono">{connectionLabel}</span>
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[920px]">
          <PageHeader
            title={connectionLabel}
            subtitle="Mint and revoke credentials for the agents pointed at this connection."
            actions={
              <Link
                href={`/connections/${conn.id}/settings`}
                className="rounded-md border border-border bg-secondary px-3 py-1.5 text-xs text-foreground transition-colors hover:border-border-strong"
              >
                Settings
              </Link>
            }
          />
          <TokenList
            connectionId={conn.id}
            tokens={tokens}
            createAction={createTokenAction}
            revokeAction={revokeTokenAction}
          />
        </div>
      </PageContainer>
    </>
  );
}
