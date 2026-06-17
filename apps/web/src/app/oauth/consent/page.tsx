import { eq } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { oauthApplication } from "@midplane-cloud/db/auth-schema";

import { BrandLockup } from "@/components/layout/brand-mark";
import { ConsentForm } from "@/components/oauth/consent-form";
import { getActorEmail } from "@/lib/org-context";
import { bootRegion } from "@/lib/region-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OAuth consent screen for the MCP `mcp` plugin — the explicit "approve this
// agent" step. The authorize endpoint redirects here with consent_code /
// client_id / scope; the auth-config before-hook forces prompt=consent so this
// always renders (the consistent branded moment before the hand-off back to the
// agent's own callback). The user is already signed in — authorize requires a
// session — so this grants, it doesn't log in.
//
// Lives OUTSIDE the (app) group: an OAuth interstitial, not a dashboard page, so
// it renders its own minimal chrome instead of the AppShell.

// Human copy per scope. `mcp` is the one that matters (database access); the
// rest are the Better Auth OIDC identity defaults, shown muted. The DB scope is
// surfaced first and prominently; unknown scopes fall back to their raw name.
const DB_SCOPE = "mcp";
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

  const grantsDbAccess = scopes.length === 0 || scopes.includes(DB_SCOPE);
  const identityScopes = scopes.filter((s) => s in IDENTITY_COPY);

  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>

      <section className="container mx-auto flex max-w-[460px] flex-1 flex-col items-center justify-center gap-7 px-4 py-16">
        {consentCode ? (
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

            <div className="w-full space-y-4 border border-border bg-card p-5">
              {grantsDbAccess && (
                <div className="flex gap-3">
                  <span aria-hidden className="mt-0.5 font-mono text-allow">
                    ✓
                  </span>
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium text-foreground">
                      Run queries through your database connections
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Each connection&apos;s policy and guardrails still apply —
                      the agent can only do what you&apos;ve allowed.
                    </p>
                  </div>
                </div>
              )}
              {identityScopes.length > 0 && (
                <div className="flex gap-3">
                  <span aria-hidden className="mt-0.5 font-mono text-subtle">
                    ·
                  </span>
                  <p className="text-xs text-muted-foreground">
                    Read{" "}
                    {identityScopes
                      .map((s) => IDENTITY_COPY[s])
                      .join(", ")
                      .replace(/, ([^,]*)$/, " and $1")}
                    .
                  </p>
                </div>
              )}
            </div>

            <ConsentForm consentCode={consentCode} />

            <div className="space-y-1 text-center">
              {email && (
                <p className="text-xs text-subtle">
                  Signed in as <span className="text-muted-foreground">{email}</span>
                </p>
              )}
              <p className="text-xs text-subtle">
                You can revoke access any time by pausing or deleting the
                connection.
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
