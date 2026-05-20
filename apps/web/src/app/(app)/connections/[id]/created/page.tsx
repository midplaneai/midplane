import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { getConnectionWithMainDatabase } from "@/lib/connections";
import { SHOW_ONCE_COOKIE } from "@/lib/show-once-cookie";

import { ShowOnceUrl } from "./show-once-url";

// Post-create success page (PR2 of mcp_url_auth_security — minimal stub;
// PR3 owns the polished UX). The default token's plaintext URL is
// delivered via an httpOnly cookie set by /connections/new's server
// action, displayed ONCE by the ShowOnceUrl client island. The island
// fires a Server Action on mount to delete the cookie — Server
// Components can read cookies but cannot mutate them, so the delete
// MUST happen behind a Server Action / Route Handler boundary.
//
// On reload the cookie is gone, so we render the "already shown"
// fallback that explains the URL is no longer retrievable and points
// to the (future) token list. A reload before the consume action
// completes is still safe: the URL is rendered for the second time,
// but the cookie has a 5-minute TTL so the worst case is bounded.

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

  // Server Components can READ cookies safely; mutation lives in the
  // consume-action.ts Server Action invoked by ShowOnceUrl on mount.
  const cookieStore = await cookies();
  const mcpUrl = cookieStore.get(SHOW_ONCE_COOKIE)?.value ?? null;

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
              <ShowOnceUrl mcpUrl={mcpUrl} />
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
