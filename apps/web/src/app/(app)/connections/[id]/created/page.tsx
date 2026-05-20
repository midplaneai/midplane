import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { getConnectionWithMainDatabase } from "@/lib/connections";

// Post-create success page (PR2 of mcp_url_auth_security — minimal stub;
// PR3 owns the polished UX). The default token's plaintext URL is
// delivered via an httpOnly cookie set by /connections/new's server
// action, displayed ONCE on this page, then the cookie is deleted on
// read so a reload removes the plaintext from view.
//
// If the cookie is absent (direct nav, reload after first read, expired
// TTL), we render a fallback that explains why the URL is no longer
// retrievable and points to PR3's future token list — keeps the
// "show once" property visible to the user rather than failing
// silently.

const SHOW_ONCE_COOKIE = "midplane.show_once_url";

export default async function ConnectionCreated({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id } = await params;
  const result = await getConnectionWithMainDatabase(customer, id);
  if (!result) redirect("/dashboard");
  const { connection } = result;

  // Read + delete the cookie atomically: a reload will see the cookie
  // absent and render the "already shown" fallback below. httpOnly
  // means the URL never enters the JS heap, only this server render.
  const cookieStore = await cookies();
  const mcpUrl = cookieStore.get(SHOW_ONCE_COOKIE)?.value ?? null;
  if (mcpUrl) {
    cookieStore.delete(SHOW_ONCE_COOKIE);
  }

  return (
    <>
      <Topbar>
        <Link href="/dashboard">
          <b className="font-medium text-foreground">Connections</b>
        </Link>
        <span className="mx-2 text-subtle">/</span>
        <span className="font-mono">
          {connection.name ?? connection.id.slice(0, 12)}
        </span>
        <span className="mx-2 text-subtle">/</span>Connected
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title="Connection ready"
            subtitle="Point your agent at the URL below. Midplane proxies its calls through your access policy."
          />

          {mcpUrl ? (
            <section className="space-y-4 rounded-lg border border-[hsl(var(--warn)/0.4)] bg-card p-6">
              <div className="space-y-1">
                <h2 className="text-sm font-medium text-foreground">
                  Copy this URL now
                </h2>
                <p className="text-xs text-muted-foreground">
                  This is the only time you&apos;ll see the full URL. We
                  store only a hashed digest; once you leave this page, the
                  plaintext is gone. Create a new token from the dashboard
                  if you lose it.
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
              <div className="pt-2">
                <Link href="/dashboard">
                  <Button size="sm">Done — open dashboard</Button>
                </Link>
              </div>
            </section>
          ) : (
            <section className="space-y-3 rounded-lg border border-border bg-card p-6">
              <h2 className="text-sm font-medium text-foreground">
                URL already shown
              </h2>
              <p className="text-xs text-muted-foreground">
                The default token&apos;s URL was displayed once when this
                connection was created. We don&apos;t persist the plaintext;
                create a new token from the dashboard to set up an
                additional agent.
              </p>
              <div className="pt-2">
                <Link href="/dashboard">
                  <Button size="sm">Open dashboard</Button>
                </Link>
              </div>
            </section>
          )}
        </div>
      </PageContainer>
    </>
  );
}
