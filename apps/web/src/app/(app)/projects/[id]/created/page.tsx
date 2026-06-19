import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ConnectAgentGuide } from "@/components/projects/connect-agent-guide";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { ShowOnceUrl } from "@/components/show-once-url";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { projectLabel } from "@/lib/format";
import { getProjectWithMainDatabase } from "@/lib/projects";
import { SHOW_ONCE_COOKIE } from "@/lib/show-once-cookie";

import { SavedItButton } from "./saved-it-button";

// Post-create success page. The default token's plaintext URL arrives
// via an httpOnly cookie set by the /projects/new server action
// (cookie crosses the redirect boundary; the React state in the calling
// component is gone by the time we render).
//
// The cookie is NOT cleared on render — that would mean an accidental
// reload or back-nav drops the user straight to "already shown" with the
// URL gone (the bug this page used to have). Instead the SavedItButton
// clears it explicitly, gated behind a short countdown, only once the
// user acknowledges they've copied it. So a reload keeps showing the URL
// until acknowledged; the cookie's 5-minute TTL still bounds exposure.
// After acknowledgment (or once the TTL lapses) the cookie is gone and we
// render the "already shown" fallback pointing back to the project
// page where the token list lives.

export default async function ProjectCreated({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id } = await params;
  const result = await getProjectWithMainDatabase(customer, id);
  if (!result) redirect("/dashboard");
  const { project } = result;

  const cookieStore = await cookies();
  const mcpUrl = cookieStore.get(SHOW_ONCE_COOKIE)?.value ?? null;
  const label = projectLabel(project);
  const projectHref = `/projects/${project.id}`;

  return (
    <>
      <Topbar>
        <Breadcrumb
          items={[
            { label: "Projects", href: "/dashboard" },
            { label, href: projectHref },
            { label: "Connected" },
          ]}
        />
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title="Project ready"
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
                    This is the{" "}
                    <strong className="font-medium text-foreground">
                      only time
                    </strong>{" "}
                    you&apos;ll see the full URL — we store only a hashed
                    digest. Copy it, then click{" "}
                    <strong className="font-medium text-foreground">
                      I&apos;ve saved it
                    </strong>{" "}
                    below; after that the plaintext is gone for good and
                    you&apos;d need to revoke the token and mint a new one
                    from the project page.
                  </p>
                </div>
                <ShowOnceUrl mcpUrl={mcpUrl} />
              </section>

              <ConnectAgentGuide
                projectName={project.name}
                region={customer.region}
                mcpUrl={mcpUrl}
              />

              <WhatsNext projectHref={projectHref} />

              <div className="pt-2">
                <SavedItButton projectHref={projectHref} />
              </div>
            </div>
          ) : (
            <section className="space-y-3 rounded-lg border border-border bg-card p-6">
              <h2 className="text-sm font-medium text-foreground">
                URL already shown
              </h2>
              <p className="text-xs text-muted-foreground">
                The default token&apos;s URL was displayed once when this
                project was created. We{" "}
                <strong className="font-medium text-foreground">
                  don&apos;t persist the plaintext
                </strong>
                ; mint a new token from the project page to set up an
                additional agent.
              </p>
              <div className="pt-2">
                <Link href={projectHref}>
                  <Button size="sm">Open project</Button>
                </Link>
              </div>
            </section>
          )}
        </div>
      </PageContainer>
    </>
  );
}

function WhatsNext({ projectHref }: { projectHref: string }) {
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-6">
      <h2 className="text-sm font-medium text-foreground">What&apos;s next</h2>
      <ol className="space-y-2 text-xs text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">1. Add the config above to your agent</span>{" "}
          using the tab for your client, then reload it.
        </li>
        <li>
          <span className="font-medium text-foreground">2. Try a query.</span>{" "}
          Ask your agent to list tables. The first request boots the
          Midplane engine in this project&apos;s region; subsequent
          requests reuse it.
        </li>
        <li>
          <span className="font-medium text-foreground">3. Watch the audit log.</span>{" "}
          Every query lands in the dashboard with its policy decision and
          which token issued it.
        </li>
      </ol>
      <p className="pt-1 text-[11px] text-subtle">
        Need more agents (separate laptops, CI, mobile)?{" "}
        <Link
          href={projectHref}
          className="text-[hsl(var(--brand))] underline underline-offset-2"
        >
          Connect another from the project page →
        </Link>
      </p>
    </section>
  );
}
