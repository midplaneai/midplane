import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { mcpGenericUrl } from "@midplane-cloud/router";

import { ConnectAgentGuide } from "@/components/projects/connect-agent-guide";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { projectLabel } from "@/lib/format";
import { getProjectWithFirstDatabase } from "@/lib/projects";
import { SHOW_ONCE_COOKIE } from "@/lib/show-once-cookie";

import { SavedItButton } from "./saved-it-button";

// Post-create success page. The default connection is OAuth: point the agent at
// the region-wide /mcp URL and sign in — no secret to copy. We also mint a
// machine token whose plaintext URL arrives via an httpOnly cookie set by the
// /projects/new server action (it has to cross the create → success redirect);
// it's offered under the connect card's "machine / CI connection" disclosure for
// headless callers, shown once.
//
// The cookie is NOT cleared on render — an accidental reload or back-nav would
// otherwise drop the machine URL before it's copied. The SavedItButton clears it
// explicitly (gated behind a short countdown); the cookie's 5-minute TTL also
// bounds exposure. After acknowledgment (or once the TTL lapses) the machine URL
// is gone, but OAuth still works — the connect card just shows the token slot as
// a placeholder.

export default async function ProjectCreated({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  const { id } = await params;
  // Resolve the project by its first database rather than a fixed "main"
  // alias — createProject now names the first DB from the DSN, so a
  // name-pinned lookup would 404 the success page and lose the show-once URL.
  const result = await getProjectWithFirstDatabase(customer, id);
  if (!result) redirect("/dashboard");
  const { project } = result;

  const cookieStore = await cookies();
  const mcpUrl = cookieStore.get(SHOW_ONCE_COOKIE)?.value ?? null;
  // The region-wide OAuth endpoint — /mcp — the connect guide leads with.
  // Computed server-side so it uses this deployment's real MCP host.
  const oauthUrl = mcpGenericUrl(customer.region, process.env);
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
            subtitle="Point your agent at the URL below and sign in — Midplane proxies its calls through your access policy. Headless callers (CI, cron) can grab a machine token under the connect card."
          />

          <div className="space-y-4">
            <ConnectAgentGuide
              projectName={project.name}
              oauthUrl={oauthUrl}
              tokenUrl={mcpUrl}
            />

            <WhatsNext projectHref={projectHref} />

            <div className="pt-2">
              {mcpUrl ? (
                <SavedItButton projectHref={projectHref} />
              ) : (
                <Link href={projectHref}>
                  <Button size="sm">Open project</Button>
                </Link>
              )}
            </div>
          </div>
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
          using the tab for your client, then reload it. Your client opens a
          browser to sign in and choose which of this project&apos;s databases
          the agent can use.
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
