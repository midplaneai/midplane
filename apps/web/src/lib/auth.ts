import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { eq } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import * as authSchema from "@midplane-cloud/db/auth-schema";

import { bootRegion } from "./region-context";
import { seatCapForOrg } from "./seats";

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
      session: {
        create: {
          // Set the active org from the user's (single) membership when a
          // session is created. Better Auth does NOT carry activeOrganizationId
          // across logins, so without this a returning user signs in org-less
          // (activeOrganizationId = null), currentCustomer() bounces them to
          // /signup/region, and re-onboarding can mint a SECOND org/customer.
          // One org == one customer, so the first membership is the right one.
          before: async (session) => {
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
