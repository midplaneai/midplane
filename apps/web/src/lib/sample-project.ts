"use server";

import { redirect } from "next/navigation";

import { analyticsGroups, groupIdentifyProject } from "@/lib/analytics";
import { currentCustomer } from "@/lib/customer";
import { requireManager } from "@/lib/org-auth";
import { getOrgContext } from "@/lib/org-context";
import { PlanLimitError, resolvePlan } from "@/lib/plan";
import { getPostHog } from "@/lib/posthog";
import { createProject } from "@/lib/projects";
import { revalidateProjectsChrome } from "@/lib/revalidate";

// Where the "Try the sample database" CTA was clicked — recorded on the funnel
// events so we can see which surface converts evaluators onto the hosted
// sample. `source` stays "dashboard" (the web channel, vs the API); this is a
// finer-grained sub-dimension.
const SAMPLE_ENTRIES = [
  "dashboard_empty",
  "project_empty",
  "new_form",
  // At-cap walls: the sample skips the project cap, so it stays offered where
  // the "upgrade to add more" wall would otherwise be a dead end.
  "dashboard_cap",
  "new_cap",
] as const;
type SampleEntry = (typeof SAMPLE_ENTRIES)[number];

/**
 * One-click "Try the sample database" path. Creates a project + database from
 * the hosted read-only sample DSN (MIDPLANE_SAMPLE_DSN) entirely server-side —
 * the DSN is never sent to the browser — then lands on the Connect pane.
 *
 * Bound directly to a <form action> (progressive enhancement), so it takes
 * FormData and returns void. Recoverable states resolve to a redirect rather
 * than an inline message: there is no form field for the user to correct, and
 * every entry point that renders the CTA has a sensible fallback screen.
 */
export async function createSampleProject(formData: FormData): Promise<void> {
  const sampleDsn = process.env.MIDPLANE_SAMPLE_DSN;
  // The CTA only renders when this is set; a missing value here means a stale
  // page or a tampered POST — send them to the real connect form.
  if (!sampleDsn) redirect("/projects/new");

  const customer = await currentCustomer();
  if (!customer) redirect("/signup");
  const { userId } = await getOrgContext();
  if (!userId) redirect("/signup");

  // Owner/admin only, like createProject's form path. The CTA is hidden from
  // members; a member who POSTs anyway lands on /projects/new, which renders
  // the "only owners and admins can add projects" notice.
  const gate = await requireManager();
  if ("error" in gate) redirect("/projects/new");

  const entryRaw = formData.get("entry");
  const entry: SampleEntry =
    typeof entryRaw === "string" &&
    (SAMPLE_ENTRIES as readonly string[]).includes(entryRaw)
      ? (entryRaw as SampleEntry)
      : "dashboard_empty";

  const entitlement = await resolvePlan();
  let id: string;
  let created: boolean;
  try {
    // OAuth-first (mintDefaultToken=false), read-only default access. name=null
    // → createProject derives the alias from the DSN's database ("sample").
    // isSample=true badges the project and keeps it off the plan project cap;
    // createProject also enforces one sample per customer under its row lock.
    ({ id, created } = await createProject(
      customer,
      sampleDsn,
      null,
      "read",
      userId,
      entitlement,
      false,
      true,
    ));
  } catch (err) {
    // createProject(isSample=true) skips the project cap, so a PlanLimitError
    // isn't expected on this path — but stay defensive: if one ever surfaces,
    // route to /projects/new (the plan-cap upgrade EmptyState) rather than
    // throwing a runtime-error overlay from a form action.
    if (err instanceof PlanLimitError) redirect("/projects/new");
    throw err;
  }

  // A sample already existed (repeat click, or a concurrent create that lost
  // the one-sample race) — createProject returned it untouched. Skip the funnel
  // events (nothing was created) and go straight to its Connect pane.
  if (!created) redirect(`/projects/${id}?section=connect`);

  // A new sample project just joined the list — refresh the shared sidebar
  // chrome across every authed route (D11). Only reached on the created path
  // (the !created redirect above throws first).
  revalidateProjectsChrome();

  groupIdentifyProject(id, { region: customer.region });
  const properties = {
    project_id: id,
    region: customer.region,
    default_access: "read",
    source: "dashboard",
    sample_database: true,
    sample_entry: entry,
  };
  const groups = analyticsGroups({ customerId: customer.id, projectId: id });
  getPostHog()?.capture({
    distinctId: userId,
    event: "project_created",
    properties,
    groups,
  });
  // createProject attaches the sample DSN as the project's first database — the
  // activation step between project_created and agent connect.
  getPostHog()?.capture({
    distinctId: userId,
    event: "database_added",
    properties: { ...properties, via: "sample" },
    groups,
  });

  // Land on the Connect tab with the one-time "created" flag so the pane can
  // flash its success banner, same as the paste-DSN flow.
  redirect(`/projects/${id}?section=connect&created=1`);
}
