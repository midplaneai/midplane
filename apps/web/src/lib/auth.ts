import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { mcp, organization } from "better-auth/plugins";
import { and, eq, isNull, or } from "drizzle-orm";
import { ulid } from "ulid";

import { customers, getDb } from "@midplane-cloud/db";
import * as authSchema from "@midplane-cloud/db/auth-schema";

import { buildStripePlugins } from "./billing";
import { getEeAuthPlugins } from "./ee-plugins";
import { hasEntitlement } from "./plan";
import { bootRegion } from "./region-context";
import { seatCapForOrg } from "./seats";
import { isSelfHost, SELF_HOST_CUSTOMER_ID, SELF_HOST_ORG_ID } from "./self-host";

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
function createAuth() {
  return betterAuth({
    appName: "midplane",
    // The OAuth 2.1 issuer for the MCP plugin's discovery metadata. The mcp
    // plugin throws "invalid_issuer" if options.baseURL isn't a concrete string
    // (it can't infer the issuer from a request the way cookie/callback URLs
    // are). Each regional app sets BETTER_AUTH_URL to its own origin (e.g.
    // https://eu.app.midplane.ai), self-host to its host — the same value
    // Better Auth already used for cookies/callbacks, now pinned explicitly.
    baseURL: process.env.BETTER_AUTH_URL,
    database: drizzleAdapter(getDb(bootRegion()), {
      provider: "pg",
      schema: { ...authSchema },
    }),
    emailAndPassword: { enabled: true },
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
          // Self-host is single-owner: the FIRST email+password signup becomes
          // the owner; every later signup is rejected. Without this, anyone who
          // could reach the instance would register — and because
          // currentCustomer() resolves ANY authed user to the one implicit
          // customer, they'd read all of the single tenant's audit data.
          //
          // The gate is an ATOMIC claim on the implicit customer row, not a
          // SELECT-then-throw: a count check is check-then-create raceable
          // (two concurrent first-signups both read zero users, both pass, both
          // get created — and both then map to the implicit tenant). The
          // single-row UPDATE + WHERE serializes concurrent signups on the row
          // lock — the first sets owner_email and commits; a racing
          // different-email signup blocks, re-reads the now-set value, updates
          // zero rows, and is rejected. The `= email` arm lets the legitimate
          // owner retry if their first attempt failed after the claim (so a
          // transient error can't brick the instance). No-op in the cloud.
          before: async (newUser) => {
            if (!isSelfHost()) return;
            const claimed = await getDb(bootRegion())
              .update(customers)
              .set({ ownerEmail: newUser.email })
              .where(
                and(
                  eq(customers.id, SELF_HOST_CUSTOMER_ID),
                  or(
                    isNull(customers.ownerEmail),
                    eq(customers.ownerEmail, newUser.email),
                  ),
                ),
              )
              .returning({ ownerEmail: customers.ownerEmail });
            if (claimed.length === 0) {
              throw new APIError("FORBIDDEN", {
                message:
                  "This Midplane instance already has an owner. Self-host is single-owner; new sign-ups are disabled.",
              });
            }
          },
          // Link the owner as a member of the implicit org so Better Auth's org
          // APIs (active organization, workspace rename/manage) work and the
          // session.create hook below can set activeOrganizationId from this
          // membership. ensureImplicitCustomer seeds the org but not this link.
          // The before-hook claim guarantees exactly one account, so exactly
          // one member is ever linked; the existence check keeps it idempotent.
          after: async (newUser) => {
            if (!isSelfHost()) return;
            const db = getDb(bootRegion());
            const existing = await db
              .select({ id: authSchema.member.id })
              .from(authSchema.member)
              .where(
                and(
                  eq(authSchema.member.userId, newUser.id),
                  eq(authSchema.member.organizationId, SELF_HOST_ORG_ID),
                ),
              )
              .limit(1);
            if (existing.length === 0) {
              await db.insert(authSchema.member).values({
                id: ulid(),
                userId: newUser.id,
                organizationId: SELF_HOST_ORG_ID,
                role: "owner",
              });
            }
          },
        },
      },
      session: {
        create: {
          // Set the active org from the user's (single) membership when a
          // session is created. Better Auth does NOT carry activeOrganizationId
          // across logins, so without this a returning user signs in org-less
          // (activeOrganizationId = null), currentCustomer() bounces them to
          // /signup/region, and re-onboarding can mint a SECOND org/customer.
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
        },
      },
    },
    plugins: [
      organization({
        // Per-plan seat cap. membershipLimit accepts a per-org function, so we
        // resolve the org's plan → seat cap (lib/seats.ts); Better Auth enforces
        // it on the invite/add path. Otherwise it's a single static number.
        membershipLimit: (_user, organization) => seatCapForOrg(organization.id),
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
      // orgId, per-seat. MUST sit after organization() (it reads org membership)
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
