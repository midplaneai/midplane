import { eq } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { oauthApplication } from "@midplane-cloud/db/auth-schema";

import { BrandLockup } from "@/components/layout/brand-mark";
import { ConsentForm } from "@/components/oauth/consent-form";
import { Card, CardContent } from "@/components/ui/card";
import { bootRegion } from "@/lib/region-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// OAuth consent screen for the MCP `mcp` plugin. The authorize endpoint
// redirects here (with consent_code / client_id / scope) when an MCP client
// requests `prompt=consent`. The user is already signed in — authorize requires
// a session — so this is the explicit grant step, not a login. Lives OUTSIDE
// the (app) group: it's an OAuth interstitial, not a dashboard page, so it
// renders its own minimal chrome instead of the AppShell.

// Human-readable copy for each scope we may grant. `mcp` is the coarse v1
// capability (full MCP access to a connection the user owns); the rest are the
// Better Auth OIDC defaults. Unknown scopes fall back to their raw name.
const SCOPE_COPY: Record<string, string> = {
  mcp: "Run queries through your Midplane database connections (each connection's policy and guardrails still apply).",
  openid: "Confirm your Midplane identity.",
  profile: "Read your name and profile image.",
  email: "Read your email address.",
  offline_access: "Stay connected without re-approving each time.",
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

  // Resolve the registered client's display name (Dynamic Client Registration
  // stores it). Falls back to the opaque client id if a name wasn't supplied.
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

  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>

      <section className="container mx-auto flex max-w-[520px] flex-1 flex-col items-center justify-center gap-8 px-4 py-16">
        {consentCode ? (
          <>
            <div className="space-y-3 text-center">
              <h1 className="text-2xl font-semibold tracking-[-0.025em] text-foreground">
                Authorize {displayName}
              </h1>
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{displayName}</span>{" "}
                is requesting access to your Midplane account as an agent.
              </p>
            </div>

            <Card className="w-full">
              <CardContent className="space-y-4 py-5">
                <p className="text-xs font-medium uppercase tracking-wide text-subtle">
                  This will allow it to
                </p>
                <ul className="space-y-3">
                  {(scopes.length ? scopes : ["mcp"]).map((scope) => (
                    <li key={scope} className="flex gap-2.5 text-sm">
                      <span aria-hidden className="mt-0.5 font-mono text-allow">
                        ✓
                      </span>
                      <span className="text-foreground">
                        {SCOPE_COPY[scope] ?? scope}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>

            <ConsentForm consentCode={consentCode} />

            <p className="text-center text-xs text-muted-foreground">
              You can revoke this access at any time by pausing or deleting the
              connection.
            </p>
          </>
        ) : (
          <div className="space-y-3 text-center">
            <h1 className="text-2xl font-semibold tracking-[-0.025em] text-foreground">
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
