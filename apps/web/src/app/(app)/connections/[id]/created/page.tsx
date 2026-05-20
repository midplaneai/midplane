import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { ShowOnceUrl } from "@/components/show-once-url";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { getConnectionWithMainDatabase } from "@/lib/connections";
import { SHOW_ONCE_COOKIE } from "@/lib/show-once-cookie";

import { consumeShowOnceCookie } from "./consume-action";

// Post-create success page. The default token's plaintext URL arrives
// via an httpOnly cookie set by the /connections/new server action
// (cookie crosses the redirect boundary; the React state in the calling
// component is gone by the time we render). The ShowOnceUrl client
// island fires a Server Action on mount to delete the cookie — Server
// Components can read but not mutate cookies in Next 15.
//
// On reload (or any second render) the cookie is gone, so we render the
// "already shown" fallback that explains the URL is no longer
// retrievable and points back to the connection page where the token
// list lives.

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

  const cookieStore = await cookies();
  const mcpUrl = cookieStore.get(SHOW_ONCE_COOKIE)?.value ?? null;
  const connectionLabel = connection.name ?? connection.id.slice(0, 12);
  const connectionHref = `/connections/${connection.id}`;

  return (
    <>
      <Topbar>
        <Link href="/dashboard">
          <b className="font-medium text-foreground">Connections</b>
        </Link>
        <span className="mx-2 text-subtle">/</span>
        <Link href={connectionHref} className="font-mono">
          {connectionLabel}
        </Link>
        <span className="mx-2 text-subtle">/</span>Connected
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title="Connection ready"
            subtitle="One default token has been minted. Point your agent at the URL below; Midplane proxies its calls through your access policy."
          />

          {mcpUrl ? (
            <div className="space-y-4">
              <section className="space-y-4 rounded-lg border border-[hsl(var(--warn)/0.4)] bg-card p-6">
                <div className="space-y-1">
                  <h2 className="text-sm font-medium text-foreground">
                    Copy this URL now
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    This is the only time you&apos;ll see the full URL. We
                    store only a hashed digest; once you leave this page the
                    plaintext is gone. Lost it? Revoke the token and mint a
                    new one from the connection page.
                  </p>
                </div>
                <ShowOnceUrl mcpUrl={mcpUrl} onMount={consumeShowOnceCookie} />
              </section>

              <WhatsNext connectionHref={connectionHref} />

              <div className="pt-2">
                <Link href={connectionHref}>
                  <Button size="sm">Done — manage tokens</Button>
                </Link>
              </div>
            </div>
          ) : (
            <section className="space-y-3 rounded-lg border border-border bg-card p-6">
              <h2 className="text-sm font-medium text-foreground">
                URL already shown
              </h2>
              <p className="text-xs text-muted-foreground">
                The default token&apos;s URL was displayed once when this
                connection was created. We don&apos;t persist the plaintext;
                mint a new token from the connection page to set up an
                additional agent.
              </p>
              <div className="pt-2">
                <Link href={connectionHref}>
                  <Button size="sm">Open connection</Button>
                </Link>
              </div>
            </section>
          )}
        </div>
      </PageContainer>
    </>
  );
}

function WhatsNext({ connectionHref }: { connectionHref: string }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-6">
      <h2 className="text-sm font-medium text-foreground">What&apos;s next</h2>
      <ol className="space-y-2 text-xs text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">1. Add the URL to your agent.</span>{" "}
          In Cursor, open <span className="font-mono text-foreground">Settings → MCP</span>{" "}
          and paste the URL as a new server. In Claude Code, add it to{" "}
          <span className="font-mono text-foreground">.claude/mcp.json</span>{" "}
          under <span className="font-mono text-foreground">servers</span>.
        </li>
        <li>
          <span className="font-medium text-foreground">2. Try a query.</span>{" "}
          Ask your agent to list tables. The first request boots the
          Midplane engine in this connection&apos;s region; subsequent
          requests reuse it.
        </li>
        <li>
          <span className="font-medium text-foreground">3. Watch the audit log.</span>{" "}
          Every query lands in the dashboard with its policy decision and
          which token issued it.
        </li>
      </ol>
      <p className="pt-1 text-[11px] text-subtle">
        Need more tokens (separate laptops, CI, mobile)?{" "}
        <Link
          href={connectionHref}
          className="text-[hsl(var(--brand))] underline underline-offset-2"
        >
          Mint another from the connection page →
        </Link>
      </p>
    </section>
  );
}
