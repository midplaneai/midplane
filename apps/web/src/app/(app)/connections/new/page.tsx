import { auth } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ACCESS_LEVELS, type AccessLevel } from "@midplane-cloud/db/policy";
import { mintMcpUrl } from "@midplane-cloud/router";

import {
  NewConnectionForm,
  type NewConnectionFormState,
} from "@/components/connections/new-connection-form";
import { Topbar, PageContainer } from "@/components/layout/app-shell";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/ui/page-header";
import { currentCustomer } from "@/lib/customer";
import { createConnection, isValidDsn } from "@/lib/connections";
import { PlanLimitError, resolvePlan, UPGRADE_URL } from "@/lib/plan";
import { getPostHog } from "@/lib/posthog";
import { SHOW_ONCE_COOKIE } from "@/lib/show-once-cookie";

// PR2 of mcp_url_auth_security: a fresh connection mints a default token
// whose plaintext is delivered ONCE via an httpOnly cookie set in the
// server action and consumed by the post-create success page's
// ShowOnceUrl client island (which fires a Server Action to delete the
// cookie). The cookie has a 5-minute TTL so a long-tail browser-back
// doesn't keep the URL retrievable. PR3 replaces this with a proper
// token management surface; this is the minimal stub specified by the
// design doc.
const SHOW_ONCE_TTL_SECONDS = 5 * 60;

export default async function NewConnection() {
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");

  return (
    <>
      <Topbar>
        <Breadcrumb
          items={[
            { label: "Connections", href: "/dashboard" },
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
          <NewConnectionForm action={createAction} />
        </div>
      </PageContainer>
    </>
  );
}

// Server action wired through useActionState in the client form. Validation
// failures return a NewConnectionFormState so the form can render the message
// inline; success calls redirect() which Next surfaces outside this channel.
// (The old `throw new Error("DSN must be a postgres:// URL")` path produced
// a runtime-error overlay instead of inline feedback — see the new form's
// state.error render.)
async function createAction(
  _prev: NewConnectionFormState,
  formData: FormData,
): Promise<NewConnectionFormState> {
  "use server";
  const customer = await currentCustomer();
  if (!customer) redirect("/signup/region");
  const { userId } = await auth();
  if (!userId) redirect("/signup/region");

  const dsn = formData.get("dsn");
  if (!isValidDsn(dsn)) {
    return { error: "DSN must be a postgres:// or postgresql:// URL." };
  }
  const nameRaw = formData.get("name");
  const name = typeof nameRaw === "string" ? nameRaw : null;

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
  let defaultTokenPlaintext: string;
  try {
    ({ id, defaultTokenPlaintext } = await createConnection(
      customer,
      dsn,
      name,
      defaultAccess,
      userId,
      entitlement,
    ));
  } catch (err) {
    if (err instanceof PlanLimitError) {
      // Return state (don't throw) so the form renders an inline upgrade
      // CTA instead of the Next runtime-error overlay — see CLAUDE.md
      // "Server actions: return state, don't throw, for user input."
      return {
        error: `You've reached your plan's connection limit (${err.limit}).`,
        upgradeUrl: UPGRADE_URL,
      };
    }
    throw err;
  }
  const mcpUrl = mintMcpUrl(customer.region, defaultTokenPlaintext, process.env);

  getPostHog()?.capture({
    distinctId: userId,
    event: "connection_created",
    properties: {
      connection_id: id,
      region: customer.region,
      default_access: defaultAccess,
      source: "dashboard",
    },
  });

  // Stash the plaintext URL in an httpOnly cookie. The success page
  // reads + deletes it; a reload of the success page shows the
  // "already consumed" state so the plaintext never appears twice in
  // the user's view. 5-minute TTL bounds the leakage window if the user
  // walks away from the browser between create and success-page-read.
  const c = await cookies();
  c.set(SHOW_ONCE_COOKIE, mcpUrl, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SHOW_ONCE_TTL_SECONDS,
    path: "/",
  });

  redirect(`/connections/${id}/created`);
}
