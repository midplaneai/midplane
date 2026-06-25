import { getOrgContext } from "@/lib/org-context";
import { redirect } from "next/navigation";

import { ACCESS_LEVELS, type AccessLevel } from "@midplane-cloud/db/policy";

import {
  NewProjectForm,
  type NewProjectFormState,
} from "@/components/projects/new-project-form";
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
  isValidDatabaseName,
  isValidDsn,
} from "@/lib/projects";
import {
  projectCreateBlock,
  PlanLimitError,
  resolvePlan,
  UPGRADE_URL,
} from "@/lib/plan";
import { getPostHog } from "@/lib/posthog";

export default async function NewProject() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  // Adding a project is an owner/admin capability — a member operates existing
  // projects, it doesn't provision new ones. Show a clear notice instead of the
  // DSN form (the createAction below also re-checks the role server-side).
  const canManage = await isManager();

  // Pre-flight the plan cap so a capped user sees the upgrade path BEFORE
  // pasting a DSN — not after submitting a form that's doomed to fail. This
  // is advisory; createAction still runs the authoritative locked check (it
  // catches the concurrent-tab race this unlocked read can't). Mirrors the
  // resource the action would throw on, so the messaging is consistent.
  const { caps, plan } = await resolvePlan();
  // A projects-cap block is cleared when the customer has a reusable empty
  // project: createProject attaches the first DB + token to it without consuming
  // a new slot, so the DSN form must stay open (a tokens-cap block still
  // stands). Without this, a fresh Free customer (auto-seeded Default, 1/1) is
  // wrongly told they're at their project limit and can't add a first database.
  const rawBlock = projectCreateBlock(await getPlanUsage(customer), caps);
  const block =
    rawBlock?.resource === "projects" && (await hasEmptyProject(customer))
      ? null
      : rawBlock;

  return (
    <>
      <Topbar>
        <Breadcrumb
          items={[
            { label: "Projects", href: "/dashboard" },
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
              title={
                block.resource === "projects"
                  ? "You've reached your plan's project limit"
                  : "You've reached your plan's token limit"
              }
              description={
                block.resource === "projects" ? (
                  <>
                    The {plan} plan includes{" "}
                    <strong className="font-medium text-foreground">
                      {block.limit}{" "}
                      {block.limit === 1 ? "project" : "projects"}
                    </strong>
                    . Upgrade to add more, or delete one you no longer use.
                  </>
                ) : (
                  <>
                    The {plan} plan includes{" "}
                    <strong className="font-medium text-foreground">
                      {block.limit}{" "}
                      {block.limit === 1 ? "agent token" : "agent tokens"}
                    </strong>
                    , and a new project mints another. Upgrade, or revoke a
                    token you no longer use.
                  </>
                )
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
            <NewProjectForm action={createAction} />
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
  if (!customer) redirect("/signup/region");
  const { userId } = await getOrgContext();
  if (!userId) redirect("/signup/region");

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
  // the agent uses to address it). Validate a supplied value so the user gets
  // inline feedback; blank is fine — createProject derives the alias from the
  // DSN's database name.
  const nameRaw = formData.get("name");
  const aliasInput = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (aliasInput && !isValidDatabaseName(aliasInput)) {
    return {
      error:
        "Database name must be 1–32 lowercase letters, digits, _ or -, starting with a letter.",
    };
  }
  const name = aliasInput || null;

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

  getPostHog()?.capture({
    distinctId: userId,
    event: "project_created",
    properties: {
      project_id: id,
      region: customer.region,
      default_access: defaultAccess,
      source: "dashboard",
    },
  });

  // Land on the project's Connect tab with a one-time "created" flag so the
  // pane can flash a success banner. No show-once secret to carry across the
  // redirect — the connect URL is non-secret and lives on the page itself.
  redirect(`/projects/${id}?section=connect&created=1`);
}
