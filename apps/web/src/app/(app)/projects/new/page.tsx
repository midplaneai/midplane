import { getOrgContext } from "@/lib/org-context";
import { redirect } from "next/navigation";

import { ACCESS_LEVELS, type AccessLevel } from "@midplane-cloud/db/policy";

import {
  NewProjectForm,
  type NewProjectFormState,
} from "@/components/projects/new-project-form";
import { SampleProjectButton } from "@/components/projects/sample-project-button";
import Link from "next/link";

import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { isManager, requireManager } from "@/lib/org-auth";
import {
  createProject,
  getPlanUsage,
  hasEmptyProject,
  isValidDsn,
  slugifyDatabaseName,
} from "@/lib/projects";
import {
  projectAddBlock,
  PlanLimitError,
  resolvePlan,
  UPGRADE_URL,
} from "@/lib/plan";
import { PROJECTS_LIST_HREF } from "@/lib/routes";
import { analyticsGroups, groupIdentifyProject } from "@/lib/analytics";
import { getPostHog } from "@/lib/posthog";

export default async function NewProject() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup");

  // Adding a project is an owner/admin capability — a member operates existing
  // projects, it doesn't provision new ones. Show a clear notice instead of the
  // DSN form (the createAction below also re-checks the role server-side).
  const canManage = await isManager();

  // Pre-flight the plan cap so a capped user sees the upgrade path BEFORE
  // pasting a DSN — not after submitting a form that's doomed to fail. This
  // is advisory; createAction still runs the authoritative locked check (it
  // catches the concurrent-tab race this unlocked read can't). The web flow
  // is OAuth-first and mints NO default token (createAction passes
  // mintDefaultToken=false, and createProject skips the token-cap check when
  // not minting) — so ONLY the project cap gates this form. Gating on
  // projectCreateBlock here used to wall off token-capped orgs whose create
  // would have succeeded.
  const { caps, plan } = await resolvePlan();
  // A projects-cap block is cleared when the customer has a reusable empty
  // project: createProject attaches the first DB to it without consuming a
  // new slot, so the DSN form must stay open. Without this, a fresh Free
  // customer (auto-seeded Default, 1/1) is wrongly told they're at their
  // project limit and can't add a first database.
  const usage = await getPlanUsage(customer);
  const rawBlock = projectAddBlock({ projects: usage.projects }, caps);
  const block =
    rawBlock && (await hasEmptyProject(customer)) ? null : rawBlock;

  return (
    <>
      <Topbar>
        <Breadcrumb
          items={[
            { label: "Projects", href: PROJECTS_LIST_HREF },
            { label: "New" },
          ]}
        />
      </Topbar>
      <PageContainer>
        <div className="mx-auto max-w-[760px]">
          <PageHeader
            title="Connect Postgres"
            subtitle={
              <>
                Paste a Postgres connection string. We encrypt it with your
                region&apos;s KMS key and{" "}
                <strong className="font-medium text-foreground">
                  never persist the plaintext
                </strong>
                .
              </>
            }
          />
          {!canManage ? (
            <EmptyState
              title="Only owners and admins can add projects"
              description="Ask an owner or admin of this workspace to add a project. You can connect your agent to existing projects from your dashboard."
              action={
                <Link href="/dashboard">
                  <Button size="sm" variant="outline">
                    Back to projects
                  </Button>
                </Link>
              }
            />
          ) : block ? (
            <EmptyState
              title="You've reached your plan's project limit"
              description={
                <>
                  The {plan} plan includes{" "}
                  <strong className="font-medium text-foreground">
                    {block.limit} {block.limit === 1 ? "project" : "projects"}
                  </strong>
                  . Upgrade to add more, or delete one you no longer use.
                </>
              }
              action={
                <div className="flex items-center gap-3">
                  <Link href={UPGRADE_URL}>
                    <Button size="sm">Upgrade your plan</Button>
                  </Link>
                  <Link href="/dashboard">
                    <Button size="sm" variant="outline">
                      Back to projects
                    </Button>
                  </Link>
                </div>
              }
            />
          ) : (
            <>
              <NewProjectForm action={createAction} />
              {/* Escape hatch for evaluators without a reachable Postgres: the
                  hosted read-only demo dataset (provisioning in
                  scripts/sample-db/). One click creates the project
                  server-side — the DSN never reaches the browser. Unset
                  (self-host, or not yet provisioned) hides the affordance. */}
              {process.env.MIDPLANE_SAMPLE_DSN ? (
                <div className="mt-6 border-t border-dashed border-border pt-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    No Postgres handy? Try Midplane against a hosted read-only
                    demo dataset — customers, subscriptions, invoices.
                  </p>
                  <div className="mt-3 flex justify-center">
                    <SampleProjectButton entry="new_form" />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>
      </PageContainer>
    </>
  );
}

// Server action wired through useActionState in the client form. Validation
// failures return a NewProjectFormState so the form can render the message
// inline; success calls redirect() which Next surfaces outside this channel.
// (The old `throw new Error("DSN must be a postgres:// URL")` path produced
// a runtime-error overlay instead of inline feedback — see the new form's
// state.error render.)
async function createAction(
  _prev: NewProjectFormState,
  formData: FormData,
): Promise<NewProjectFormState> {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/signup");
  const { userId } = await getOrgContext();
  if (!userId) redirect("/signup");

  // Owner/admin only. Return state (don't throw) so the client form renders it
  // inline — this is the tamper path; the page already hides the form for
  // members. See CLAUDE.md "Server actions: return state, don't throw."
  const gate = await requireManager("Only an owner or admin can add projects.");
  if ("error" in gate) return { error: gate.error };

  const dsn = formData.get("dsn");
  if (!isValidDsn(dsn)) {
    return { error: "DSN must be a postgres:// or postgresql:// URL." };
  }
  // The optional name is the first database's agent-facing alias (the string
  // the agent uses to address it). Coerce it to the engine's name grammar
  // rather than rejecting: the form submits an already-slugified hidden value,
  // and hardening the server (for JS-off / non-browser callers) keeps the
  // stored alias matching the form's live "Saved as …" preview. Empty after
  // slugifying (no usable chars) → null, and createProject derives the alias
  // from the DSN's database name.
  const nameRaw = formData.get("name");
  const rawInput = typeof nameRaw === "string" ? nameRaw : "";
  const name = slugifyDatabaseName(rawInput) || null;

  // Form-posted radio values are strings. Validate against the canonical
  // enum so a tampered request can't smuggle in something the spawner
  // would later refuse — and so a missing field falls back to `read`.
  const accessRaw = formData.get("default_access");
  const defaultAccess: AccessLevel =
    typeof accessRaw === "string" &&
    (ACCESS_LEVELS as readonly string[]).includes(accessRaw)
      ? (accessRaw as AccessLevel)
      : "read";

  const entitlement = await resolvePlan();
  let id: string;
  try {
    // OAuth-first: no auto-minted token. The user lands on the project's
    // Connect tab and points an agent at the OAuth URL (or mints a machine
    // token explicitly). mintDefaultToken=false also keeps the create from
    // consuming a token slot on a credential nobody would ever see.
    ({ id } = await createProject(
      customer,
      dsn,
      name,
      defaultAccess,
      userId,
      entitlement,
      false,
    ));
  } catch (err) {
    if (err instanceof PlanLimitError) {
      // Return state (don't throw) so the form renders an inline upgrade
      // CTA instead of the Next runtime-error overlay — see CLAUDE.md
      // "Server actions: return state, don't throw, for user input."
      return {
        error: `You've reached your plan's project limit (${err.limit}).`,
        upgradeUrl: UPGRADE_URL,
      };
    }
    throw err;
  }

  // Whether the evaluator took the hosted sample-database escape hatch
  // instead of bringing their own Postgres — the funnel's BYO-Postgres
  // constraint made measurable. False whenever the sample DSN isn't
  // configured on this deployment.
  const sampleDb = process.env.MIDPLANE_SAMPLE_DSN
    ? dsn === process.env.MIDPLANE_SAMPLE_DSN
    : false;

  groupIdentifyProject(id, { region: customer.region });
  getPostHog()?.capture({
    distinctId: userId,
    event: "project_created",
    properties: {
      project_id: id,
      region: customer.region,
      default_access: defaultAccess,
      source: "dashboard",
      sample_database: sampleDb,
    },
    groups: analyticsGroups({ customerId: customer.id, projectId: id }),
  });
  // createProject attaches the form's DSN as the project's first database
  // (possibly onto the reused empty "Default" project) — the activation step
  // between project_created and agent connect (launch-analytics spec §4).
  getPostHog()?.capture({
    distinctId: userId,
    event: "database_added",
    properties: {
      project_id: id,
      region: customer.region,
      default_access: defaultAccess,
      source: "dashboard",
      via: "project_create",
      sample_database: sampleDb,
    },
    groups: analyticsGroups({ customerId: customer.id, projectId: id }),
  });

  // Land on the project's Connect tab with a one-time "created" flag so the
  // pane can flash a success banner. No show-once secret to carry across the
  // redirect — the connect URL is non-secret and lives on the page itself.
  redirect(`/projects/${id}?section=connect&created=1`);
}
