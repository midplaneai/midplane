import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { mcp, organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import { customers, getDb } from "@midplane-cloud/db";
import * as authSchema from "@midplane-cloud/db/auth-schema";
import { mcpOrigin } from "@midplane-cloud/router";

import {
  analyticsGroups,
  captureError,
  redactForCapture,
} from "./analytics";
import { buildStripePlugins } from "./billing";
import { getEeAuthPlugins } from "./ee-plugins";
import { isEmailConfigured, sendPasswordResetEmail } from "./email";
import { getPostHog } from "./posthog";
import { hasEntitlement } from "./plan";
import { bootRegion } from "./region-context";
import { APEX_HOST, REGION_HOST } from "./region-routing";
import { seatCapForOrg } from "./seats";
import { googleAuthEnabled } from "./social-auth";
import {
  enforceSelfHostSignupGate,
  linkSelfHostOwnerMember,
} from "./self-host-gate";
import { isSelfHost, SELF_HOST_ORG_ID } from "./self-host";
import { handleBeforeUserDelete } from "./workspace";

// Better Auth instance for the CLOUD build.
//
// Bound to THIS process's regional DB (MIDPLANE_REGION → getDb), the same
// single-region binding customer.ts uses: auth data is region-resident, never
// central. Region routing itself does NOT live in the session — it's a
// separate signed cookie — so the regional DB choice stays decoupled from auth.
//
// Construction is LAZY (getAuth) so importing this module is side-effect-free:
// bootRegion()/getDb() only run when a request actually reaches /api/auth/*,
// never at `next build` or module-eval (getDb throws when DATABASE_URL_<REGION>
// is unset, which is the normal state during build and in some dev/test runs).
// Every first-party origin a browser can send auth requests from. Better Auth's
// origin check (CSRF) rejects any request whose Origin isn't trusted with
// "Invalid origin". Left unset it trusts ONLY the single BETTER_AUTH_URL origin
// — which is wrong here because one image answers on SEVERAL hosts: the EU app
// serves both the apex (app.midplane.ai) and its regional subdomain
// (eu.app.midplane.ai), so whichever host isn't BETTER_AUTH_URL would be
// rejected (a sign-in from eu.app.midplane.ai failing "Invalid origin"). We
// enumerate from the same host constants the region router uses, so there's one
// source of truth. Self-host serves a single host and trusts only its own.
function trustedAuthOrigins(): string[] {
  const origins = new Set<string>();
  const base = process.env.BETTER_AUTH_URL;
  if (base) {
    try {
      origins.add(new URL(base).origin);
    } catch {
      // assertBootEnv already requires BETTER_AUTH_URL to be set; a malformed
      // value surfaces there, not here.
    }
  }
  // Self-host is single-host: nothing beyond its own origin to trust.
  if (isSelfHost()) return [...origins];

  // Cloud: the apex picker and BOTH regional dashboards are first-party hosts a
  // browser legitimately posts auth from (the EU app answers on the apex too).
  origins.add(`https://${APEX_HOST}`);
  for (const host of Object.values(REGION_HOST)) {
    origins.add(`https://${host}`);
  }
  // MCP endpoint hosts (agents authenticate here; discovery may be fetched
  // cross-origin). First-party, so trusting them is safe and defensive.
  for (const host of [
    process.env.MIDPLANE_PUBLIC_HOST_EU,
    process.env.MIDPLANE_PUBLIC_HOST_US,
  ]) {
    if (host) origins.add(`https://${host}`);
  }
  return [...origins];
}

function createAuth() {
  // Pin this process's region ONCE. Used for the regional DB binding (below)
  // and for the MCP-endpoint origin the mcp() plugin advertises as its OAuth
  // protected-resource `resource` (see that plugin's config).
  const region = bootRegion();
  return betterAuth({
    appName: "midplane",
    // The OAuth 2.1 issuer for the MCP plugin's discovery metadata. The mcp
    // plugin throws "invalid_issuer" if options.baseURL isn't a concrete string
    // (it can't infer the issuer from a request the way cookie/callback URLs
    // are). Each regional app sets BETTER_AUTH_URL to its own origin (e.g.
    // https://eu.app.midplane.ai), self-host to its host — the same value
    // Better Auth already used for cookies/callbacks, now pinned explicitly.
    baseURL: process.env.BETTER_AUTH_URL,
    // Trust every first-party host this image serves (apex + regional
    // subdomains), not just BETTER_AUTH_URL — see trustedAuthOrigins.
    trustedOrigins: trustedAuthOrigins(),
    database: drizzleAdapter(getDb(region), {
      provider: "pg",
      schema: { ...authSchema },
    }),
    emailAndPassword: {
      enabled: true,
      // A password reset mints a fresh credential; drop every other live
      // session so a leaked/forgotten one can't outlive the reset.
      revokeSessionsOnPasswordReset: true,
      // "Forgot password" by email. Registered ONLY when this build can send
      // email (cloud + Resend) — self-host / keyless dev have no SMTP, so no
      // reset is offered and the UI gates on isEmailConfigured() the same way
      // (same hygiene as the Google/Stripe/ee conditionals). requestPasswordReset
      // returns a uniform success whether or not the email exists, so the send
      // is best-effort: a Resend outage must not turn that into an error the
      // caller can distinguish (which would leak existence).
      ...(isEmailConfigured()
        ? {
            sendResetPassword: async ({
              user: resetUser,
              url,
            }: {
              user: { id?: string; email: string };
              url: string;
            }) => {
              try {
                await sendPasswordResetEmail({
                  to: resetUser.email,
                  resetUrl: url,
                });
              } catch (err) {
                console.error("password reset email failed", err);
                // Swallowed BY DESIGN toward the caller (anti-enumeration),
                // which makes this capture the only visibility a Resend
                // outage gets. Redact the address (case-insensitively —
                // providers echo it back normalized) — bare emails aren't
                // in the scrubber's patterns.
                const message = redactForCapture(
                  err instanceof Error ? err.message : String(err),
                  resetUser.email,
                );
                captureError(
                  "auth.password_reset_email_failed",
                  new Error(message),
                  { distinctId: resetUser.id },
                );
              }
            },
          }
        : {}),
    },
    // Self-service account deletion (account page → danger zone). Better Auth
    // verifies intent first — a password for credential users, or a fresh
    // session otherwise — then calls beforeDelete BEFORE removing the user row.
    // handleBeforeUserDelete is where the workspace-teardown rule is enforced
    // (sole-owner → delete the workspace; owner-with-members → refuse; non-owner
    // → just leave) and is the security backstop for the UI's pre-check. We send
    // no verification email: the password / fresh-session check is the gate.
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (deletingUser) => {
          await handleBeforeUserDelete(deletingUser.id);
        },
      },
    },
    // Google sign-in. Conditional on creds being present (same hygiene as the
    // Stripe/ee plugins below): unset → {} → no provider, so keyless dev and
    // self-host boot without Google env. Self-host gets Google only by setting
    // GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET explicitly. The UI gates on the
    // same googleAuthEnabled() check, so a credential-less build never renders
    // the button. New users still flow through the user.create databaseHook
    // above (self-host single-owner gate, owner member-link) — Google doesn't
    // bypass it. The OAuth callback is <BETTER_AUTH_URL>/api/auth/callback/google
    // per region; each regional origin must be registered in the Google console.
    socialProviders: googleAuthEnabled()
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID as string,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
          },
        }
      : {},
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Entitlement gate (server-side, ee/SSO). Creating or modifying an SSO
        // provider requires the `sso` entitlement (ee build AND the Team plan).
        // The @better-auth/sso plugin only enforces org owner/admin on these
        // endpoints, so WITHOUT this a Free/Pro org admin in an ee build could
        // POST /api/auth/sso/register (or /sso/update-provider) directly and
        // stand up a working provider, bypassing the UI gate. We gate only the
        // CREATE/MODIFY paths — sign-in, the SAML callbacks, SP metadata, and
        // domain verification of an already-created provider keep working (no
        // clawback on a downgrade, matching the plan model). hasEntitlement()
        // re-reads the session via /get-session, which doesn't match these
        // paths, so there's no recursion. (No-op in keyless/self-host builds:
        // the SSO plugin isn't loaded, so these paths never resolve.)
        if (
          ctx.path === "/sso/register" ||
          ctx.path === "/sso/update-provider"
        ) {
          if (!(await hasEntitlement("sso"))) {
            throw new APIError("FORBIDDEN", {
              message: "Single sign-on isn’t available on your plan.",
            });
          }
          return;
        }

        // Shape every MCP OAuth authorize request before the plugin handles it:
        //
        //  - prompt=consent: Better Auth only renders the consent page when the
        //    request carries it, and MCP clients don't reliably send it — which
        //    would skip our approval step and jump straight to the client's own
        //    callback. Forcing it guarantees the user explicitly approves each
        //    agent before it can reach their databases, and makes our consent
        //    screen the consistent branded moment.
        //  - scope ⊇ mcp: the proxy REQUIRES the `mcp` scope on the access token
        //    (lib/proxy.ts proxyMcpOAuth) so a token minted for some other
        //    purpose can't reach a database. Injecting it here means a compliant
        //    client always gets a usable token regardless of which scopes it
        //    requested, while the proxy still rejects tokens that lack it.
        //
        // Both ride the login-resume path too: authorizeMCPOAuth stores this
        // query in the oidc_login_prompt cookie before bouncing to /sign-in, so
        // the post-login resume sees the same prompt + scope.
        if (ctx.path === "/mcp/authorize") {
          const scopes = new Set(
            String(ctx.query?.scope ?? "")
              .split(" ")
              .filter(Boolean),
          );
          scopes.add("mcp");
          return {
            context: {
              ...ctx,
              query: {
                ...ctx.query,
                prompt: "consent",
                scope: Array.from(scopes).join(" "),
              },
            },
          };
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Self-host single-owner gate, with an invited-teammate exception.
          // currentCustomer() resolves ANY authed user to the one implicit
          // customer, so SIGNUP is the data-isolation boundary: the first
          // signup claims owner; later signups are rejected UNLESS the email
          // has a pending, owner-issued invitation. Security-critical and
          // race-safe — see lib/self-host-gate.ts. No-op in the cloud.
          before: async (newUser) => {
            await enforceSelfHostSignupGate(newUser.email);
          },
          // Link the OWNER as an `owner` member of the implicit org so Better
          // Auth's org APIs (active organization, workspace rename/manage)
          // work. Invited teammates are linked by acceptInvitation (with the
          // invite's role), not here — see lib/self-host-gate.ts. No-op in the
          // cloud.
          after: async (newUser) => {
            await linkSelfHostOwnerMember(newUser);
          },
        },
      },
      session: {
        create: {
          // Set the active org from the user's (single) membership when a
          // session is created. Better Auth does NOT carry activeOrganizationId
          // across logins, so without this a returning user signs in org-less
          // (activeOrganizationId = null), currentCustomer() bounces them to
          // /signup, and re-onboarding can mint a SECOND org/customer.
          // One org == one customer, so the first membership is the right one.
          before: async (session) => {
            // Self-host: the active org is ALWAYS the one implicit org. Set it
            // deterministically rather than via the membership lookup below —
            // at signup the owner's member row may not yet be visible to this
            // hook, which would leave the FIRST session with a null active org
            // (and only fix itself on a later login). A constant avoids that
            // timing entirely; the member row (user.create.after) still backs
            // the permission checks org management performs.
            if (isSelfHost()) {
              return {
                data: { ...session, activeOrganizationId: SELF_HOST_ORG_ID },
              };
            }
            const rows = await getDb(bootRegion())
              .select({ organizationId: authSchema.member.organizationId })
              .from(authSchema.member)
              .where(eq(authSchema.member.userId, session.userId))
              .limit(1);
            const orgId = rows[0]?.organizationId;
            return orgId
              ? { data: { ...session, activeOrganizationId: orgId } }
              : undefined;
          },
          // Retention baseline: fires on every login, all methods (password,
          // Google, SSO) — the app has no pageviews, so this is the human
          // "came back" signal. Posthog-gated up front so self-host /
          // keyless dev pay zero extra queries, and FIRE-AND-FORGET: Better
          // Auth awaits after-hooks before the sign-in response returns, so
          // the customers lookup must not serialize into login latency (and
          // a failure must never break session creation).
          after: async (session) => {
            void (async () => {
              // getPostHog() INSIDE the detached async scope: Better Auth
              // awaits this hook before the sign-in response, so nothing
              // throwable (even a client-constructor failure) may run on
              // the synchronous part of the login path.
              const posthog = getPostHog();
              if (!posthog) return;
              const orgId = (
                session as { activeOrganizationId?: string | null }
              ).activeOrganizationId;
              // Org group key is customers.id (analytics.ts rationale); the
              // session only carries the Better Auth orgId → one lookup.
              let customerId: string | null = null;
              if (orgId) {
                const rows = await getDb(bootRegion())
                  .select({ id: customers.id })
                  .from(customers)
                  .where(eq(customers.orgId, orgId))
                  .limit(1);
                customerId = rows[0]?.id ?? null;
              }
              posthog.capture({
                distinctId: session.userId,
                event: "signed_in",
                properties: {
                  region: isSelfHost() ? "self-host" : bootRegion(),
                },
                groups: analyticsGroups({ customerId }),
              });
            })().catch((err) => {
              console.warn("signed_in capture failed (continuing)", err);
            });
          },
        },
      },
    },
    plugins: [
      organization({
        // Per-plan seat cap. membershipLimit accepts a per-org function, so we
        // resolve the org's plan → seat cap (lib/seats.ts); Better Auth enforces
        // it on the invite/add path. Otherwise it's a single static number.
        membershipLimit: (_user, organization) => seatCapForOrg(organization.id),
        // We deliberately do NOT wire sendInvitationEmail here. The createInvite
        // server action (settings/members-actions.ts) sends the email itself
        // (cloud, via Resend) AFTER createInvitation succeeds, so it can report
        // the TRUE delivery result to the owner — the plugin callback swallows
        // its own outcome, so wiring it here would force createInvite to assume
        // a send it can't observe. Self-host sends nothing: the owner shares the
        // copyable link out-of-band (keyless, no SMTP).
        //
        // invitationExpiresIn bounds the link's validity — 7 days, longer than
        // the 48h default to tolerate an out-of-band hand-off, but still a hard
        // expiry on a capability link.
        invitationExpiresIn: 60 * 60 * 24 * 7,
      }),
      // MCP OAuth 2.1 provider (P6). Turns this app into the authorization
      // server MCP clients (Claude, Cursor) authenticate against: discovery
      // metadata, Dynamic Client Registration, authorization-code + PKCE, token
      // issuance. The /mcp resource server (lib/proxy.ts withMcpAuth) validates
      // the issued bearer. loginPage is where an unauthenticated authorize
      // bounces; consentPage renders our grant screen (forced on every authorize
      // by the prompt=consent before-hook above). requirePKCE enforces OAuth 2.1
      // PKCE at the authorize step, not just at the public-client token exchange.
      //
      // Placed AFTER organization() and BEFORE nextCookies() — nextCookies must
      // stay last to flush Set-Cookie from server-action auth flows.
      mcp({
        loginPage: "/sign-in",
        // RFC 9728 protected-resource `resource`. Unset, Better Auth advertises
        // the ISSUER origin (`new URL(BETTER_AUTH_URL).origin`, e.g.
        // https://us.app.midplane.ai) in BOTH protected-resource routes (the
        // plugin's /api/auth/.well-known/oauth-protected-resource and the root
        // mirror via oAuthProtectedResourceMetadata) — but agents connect to the
        // MCP-endpoint host (https://us.midplane.ai/mcp). A strict client (Claude
        // Code SDK) validates the advertised resource against the URL it connected
        // to and rejects the mismatch ("Protected resource … does not match
        // expected …"). Advertise the MCP-endpoint ORIGIN instead — the one value
        // that matches both /mcp and /mcp/<projectId> (clients accept the origin).
        // mcpOrigin is the same source of truth every displayed MCP URL uses, so
        // cloud (per-region host), self-host (BETTER_AUTH_URL), and dev
        // (localhost:3000) all resolve correctly. authorization_servers stays the
        // issuer origin — the auth server genuinely lives on the issuer host.
        resource: mcpOrigin(region, process.env),
        oidcConfig: {
          // loginPage is also required on the OIDCOptions type; the plugin
          // overrides it with the top-level value, so keep them the same.
          loginPage: "/sign-in",
          consentPage: "/oauth/consent",
          requirePKCE: true,
          // The `mcp` capability scope — the proxy REQUIRES it on the access
          // token before granting MCP access (lib/proxy.ts proxyMcpOAuth). Listed
          // alongside the plugin defaults (openid/profile/email/offline_access)
          // so a client may request it.
          scopes: ["mcp"],
        },
      }),
      // Stripe billing (@better-auth/stripe). Conditionally loaded: [] in
      // self-host and in keyless cloud dev, so neither requires Stripe env to
      // boot; the configured plugin otherwise. Customer-per-org, referenceId =
      // orgId, flat per-org. MUST sit after organization() (it reads org membership)
      // and before nextCookies(). It registers /api/auth/stripe/webhook —
      // already public via the /api/auth middleware prefix.
      ...buildStripePlugins(),
      // Enterprise Edition plugins (SSO/SAML). Empty unless the ee build
      // registered them at boot (lib/ee-plugins.ts ← src/ee/register.ts, wired
      // by instrumentation under MIDPLANE_EE). Core never imports ee/ — it reads
      // this neutral registry — so a keyless build or a deleted ee/ just yields
      // []. Spread AFTER stripe and BEFORE nextCookies(): SSO org-provisioning
      // relies on organization() (already above), and nextCookies must stay last.
      ...getEeAuthPlugins(),
      // nextCookies MUST stay last: it flushes Set-Cookie from server-action
      // auth flows through Next's cookies() helper.
      nextCookies(),
    ],
  });
}

let cached: ReturnType<typeof createAuth> | null = null;

/** The process-wide Better Auth instance, constructed on first use (request
 *  scope) so importing this module never touches getDb. */
export function getAuth(): ReturnType<typeof createAuth> {
  return (cached ??= createAuth());
}

/** Inferred session shape (user + session), for typing the middleware/server
 *  reads that swap onto Better Auth in a later step. */
export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
