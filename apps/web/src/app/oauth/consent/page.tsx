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
// database scope is now expressed by the picker itself, not a bullet. openid
// grants no data access ("you can sign in"), so it's intentionally omitted —
// listing it ("confirm your identity") was noise on a consent screen.
// Each phrase carries its own verb so the joined list reads as a single
// grammatical sentence after the "It will also " lead-in (a shared "read"
// lead-in can't govern this mix of verb- and noun-phrases).
const IDENTITY_COPY: Record<string, string> = {
  profile: "read your name and profile image",
  email: "read your email",
  offline_access: "stay connected without re-approving",
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
  // Display-side hardening only (the stored name is untouched): DCR names are
  // attacker-registered free text. Strip control/format chars (a bidi override
  // would reverse the H1), collapse whitespace, and clamp the length so a
  // multi-KB name can't blow out the hero.
  const rawName = (appName || clientId || "An MCP client")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const nameChars = [...rawName];
  const displayName =
    (nameChars.length > 80 ? `${nameChars.slice(0, 79).join("")}…` : rawName) ||
    "An MCP client";
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

  // Pre-select ONLY the project this credential is already bound to (the project
  // that owns a prior grant) on a re-consent. Deliberately NO first-project
  // fallback: the URL is account-wide, so silently defaulting a fresh multi-
  // project consent to projects[0] is how an agent gets bound to the wrong
  // project. The form auto-selects when there's exactly one project and
  // otherwise forces an explicit pick. One OAuth credential → one project.
  const existingCdbIds = new Set(Object.keys(existing));
  const boundProject = projects.find((p) =>
    p.databases.some((d) => existingCdbIds.has(d.projectDatabaseId)),
  );
  const defaultProjectId = boundProject?.projectId ?? null;

  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>

      <section className="container mx-auto flex max-w-[460px] flex-1 flex-col items-center justify-center gap-7 px-4 py-16">
        {ready && clientId ? (
          <>
            <div className="flex flex-col items-center gap-4 text-center">
              {/* Agent → Midplane handshake, so the grantor is in the
                  composition, not just the header chrome. Neutral monogram for
                  the agent — we deliberately don't render the client's
                  self-supplied logo URL (tracking + spoofing surface). */}
              <div aria-hidden className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center border border-border bg-secondary font-mono text-lg font-medium text-foreground">
                  {/* Spread, not charAt: an astral-plane first char must not
                      render as a lone surrogate. */}
                  {[...displayName][0]?.toUpperCase()}
                </div>
                <span className="font-mono text-sm text-subtle">→</span>
                <div className="flex h-12 w-12 items-center justify-center border border-border bg-secondary">
                  {/* Inlined bare-colon mark (mirrors /brand/icon-bare.svg): a
                      trust-critical "grant access?" surface must not depend on a
                      separately-served static file — a public/ 404 once rendered
                      a broken image here. Inline SVG needs no fetch and no image
                      runtime. */}
                  <svg
                    width={20}
                    height={20}
                    viewBox="0 0 100 100"
                    fill="none"
                    aria-hidden
                  >
                    <circle cx={50} cy={28} r={14} fill="#1d4eff" />
                    <circle cx={50} cy={72} r={14} fill="#1d4eff" />
                  </svg>
                </div>
              </div>
              <div className="space-y-1.5">
                <h1 className="text-balance text-xl font-semibold tracking-[-0.02em] text-foreground">
                  Connect {displayName}?
                </h1>
                <p className="text-sm text-muted-foreground">
                  This name is self-reported by the agent — approve only if you
                  recognize it.
                </p>
              </div>
            </div>

            <ConsentForm
              consentCode={consentCode!}
              clientId={clientId}
              projects={projects}
              defaultProjectId={defaultProjectId}
              existing={existing}
            />

            <div className="max-w-[400px] space-y-1 text-center">
              {identityScopes.length > 0 && (
                <p className="text-xs text-subtle">
                  It will also{" "}
                  {identityScopes
                    .map((s) => IDENTITY_COPY[s])
                    .join(", ")
                    .replace(/, ([^,]*)$/, " and $1")}
                  .
                </p>
              )}
              {email && (
                <p className="text-xs text-subtle">
                  Signed in as <span className="text-muted-foreground">{email}</span>
                </p>
              )}
              {/* Re-running the flow is the one path available in every role
                  and state (Connect-tab revoke is manager-gated, and a
                  zero-project approval has no Connect tab at all). */}
              <p className="text-xs text-subtle">
                Change or revoke access any time from the project&apos;s
                Connect tab, or by re-running this flow.
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
