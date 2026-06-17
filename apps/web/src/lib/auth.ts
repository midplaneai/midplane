import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { and, eq, isNull, or } from "drizzle-orm";
import { ulid } from "ulid";

import { customers, getDb } from "@midplane-cloud/db";
import * as authSchema from "@midplane-cloud/db/auth-schema";

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
    database: drizzleAdapter(getDb(bootRegion()), {
      provider: "pg",
      schema: { ...authSchema },
    }),
    emailAndPassword: { enabled: true },
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
