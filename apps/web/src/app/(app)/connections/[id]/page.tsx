import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { TokenList } from "@/components/tokens/token-list";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/ui/page-header";
import { getConnectionWithMainDatabase, getPlanUsage } from "@/lib/connections";
import { currentCustomer } from "@/lib/customer";
import { resolvePlan, UPGRADE_URL } from "@/lib/plan";
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

  // Pre-flight the token cap so "Connect an agent" reflects the limit BEFORE
  // the modal opens — same advisory-UX-over-authoritative-check split as the
  // connection create flow (createToken still enforces under a row lock). The
  // token cap is org-wide (all connections), so we read total usable tokens,
  // not this connection's count.
  const { plan, caps } = await resolvePlan();
  const usage = await getPlanUsage(customer);
  const tokenLimit =
    Number.isFinite(caps.tokens) && usage.tokens >= caps.tokens
      ? { limit: caps.tokens, plan, upgradeUrl: UPGRADE_URL }
      : undefined;

  const connectionLabel = conn.name ?? conn.id.slice(0, 12);

  return (
    <>
      <Topbar>
        <Breadcrumb
          items={[
            { label: "Connections", href: "/dashboard" },
            { label: connectionLabel },
          ]}
        />
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[920px]">
          <PageHeader
            title={connectionLabel}
            subtitle={
              <>
                This connection is a{" "}
                <strong className="font-medium text-foreground">
                  hosted MCP server
                </strong>
                . Each agent gets its own credentialed URL — paste it into
                Cursor, Claude Code, or any MCP client.
              </>
            }
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
            connectionName={conn.name}
            region={conn.region}
            tokens={tokens}
            createAction={createTokenAction}
            revokeAction={revokeTokenAction}
            tokenLimit={tokenLimit}
          />
        </div>
      </PageContainer>
    </>
  );
}
