import { eq } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { oauthApplication } from "@midplane-cloud/db/auth-schema";

import { BrandLockup } from "@/components/layout/brand-mark";
import { ConsentForm } from "@/components/oauth/consent-form";
import { currentCustomer } from "@/lib/customer";
import { getActorEmail, getOrgContext } from "@/lib/org-context";
import { bootRegion } from "@/lib/region-context";
import { getOAuthGrantMap, listGrantableDatabases } from "@/lib/scope-grants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OAuth consent screen for the MCP `mcp` plugin — the explicit "approve this
// agent + choose its databases" step. The authorize endpoint redirects here with
// consent_code / client_id / scope; the auth-config before-hook forces
// prompt=consent so this always renders (the consistent branded moment before
// the hand-off back to the agent's own callback). The user is already signed in
// (authorize requires a session), so this grants — it doesn't log in.
//
// P6.1: the screen is a per-DATABASE least-privilege picker. The user chooses
// which of their databases the agent may reach, and at what access. The picker
// writes mcp_scope_grants (keyed by this OAuth client + the user) which the
// proxy enforces on every request (X-Midplane-Scope). See ConsentForm.
//
// Lives OUTSIDE the (app) group: an OAuth interstitial, not a dashboard page, so
// it renders its own minimal chrome instead of the AppShell.

// Identity scopes are the Better Auth OIDC defaults — shown muted; the `mcp`
// database scope is now expressed by the picker itself, not a bullet.
const IDENTITY_COPY: Record<string, string> = {
  openid: "confirm your identity",
  profile: "your name and profile image",
  email: "your email address",
  offline_access: "staying connected without re-approving each time",
};

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const consentCode = typeof sp.consent_code === "string" ? sp.consent_code : null;
  const clientId = typeof sp.client_id === "string" ? sp.client_id : null;
  const scopeParam = typeof sp.scope === "string" ? sp.scope : "";
  const scopes = scopeParam.split(" ").filter(Boolean);

  // The registered client's display name (Dynamic Client Registration stores
  // it). Client-asserted, so we frame it as such; falls back to the opaque id.
  let appName: string | null = null;
  if (clientId) {
    const rows = await getDb(bootRegion())
      .select({ name: oauthApplication.name })
      .from(oauthApplication)
      .where(eq(oauthApplication.clientId, clientId))
      .limit(1);
    appName = rows[0]?.name ?? null;
  }
  const displayName = appName || clientId || "An MCP client";
  const email = await getActorEmail();

  const identityScopes = scopes.filter((s) => s in IDENTITY_COPY);

  // Load the databases the user can grant + any prior grant for this client, so
  // the picker pre-selects a re-consent. Only needed when there's a request to
  // act on (consent_code + client_id present).
  const ready = Boolean(consentCode && clientId);
  const customer = ready ? await currentCustomer() : null;
  const { userId } = ready ? await getOrgContext() : { userId: null };
  const projects = customer ? await listGrantableDatabases(customer) : [];
  const existing =
    customer && clientId && userId
      ? Object.fromEntries(await getOAuthGrantMap(customer, clientId, userId))
      : {};

  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>

      <section className="container mx-auto flex max-w-[460px] flex-1 flex-col items-center justify-center gap-7 px-4 py-16">
        {ready && clientId ? (
          <>
            <div className="flex flex-col items-center gap-4 text-center">
              {/* Neutral monogram — we deliberately don't render the client's
                  self-supplied logo URL (tracking + spoofing surface). */}
              <div className="flex h-12 w-12 items-center justify-center border border-border bg-secondary font-mono text-lg font-medium text-foreground">
                {displayName.charAt(0).toUpperCase()}
              </div>
              <div className="space-y-1.5">
                <h1 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
                  Connect {displayName}?
                </h1>
                <p className="text-sm text-muted-foreground">
                  An agent identifying itself as{" "}
                  <span className="font-medium text-foreground">
                    {displayName}
                  </span>{" "}
                  wants to connect to your Midplane account.
                </p>
              </div>
            </div>

            {identityScopes.length > 0 && (
              <div className="flex w-full gap-3">
                <span aria-hidden className="mt-0.5 font-mono text-subtle">
                  ·
                </span>
                <p className="text-xs text-muted-foreground">
                  It will also read{" "}
                  {identityScopes
                    .map((s) => IDENTITY_COPY[s])
                    .join(", ")
                    .replace(/, ([^,]*)$/, " and $1")}
                  .
                </p>
              </div>
            )}

            <ConsentForm
              consentCode={consentCode!}
              clientId={clientId}
              projects={projects}
              existing={existing}
            />

            <div className="space-y-1 text-center">
              {email && (
                <p className="text-xs text-subtle">
                  Signed in as <span className="text-muted-foreground">{email}</span>
                </p>
              )}
              <p className="text-xs text-subtle">
                You can revoke access any time by pausing or deleting the
                project, or re-running this flow.
              </p>
            </div>
          </>
        ) : (
          <div className="space-y-2 text-center">
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
              Nothing to authorize
            </h1>
            <p className="text-sm text-muted-foreground">
              This page is reached during an MCP client&apos;s sign-in flow.
              There&apos;s no pending authorization request to act on.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
