"use server";

import { and, eq } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { ssoProvider } from "@midplane-cloud/db/auth-schema";

import { requireManager } from "@/lib/org-auth";
import { hasEntitlement } from "@/lib/plan";
import { bootRegion } from "@/lib/region-context";

// Remove the active org's SAML project. The @better-auth/sso plugin enforces
// owner/admin on register (organizationId is supplied) but exposes no delete, so
// we own the delete: re-check the entitlement + owner/admin role here, then drop
// the org's provider row. Reached from a client component wrapped in
// useTransition + try/catch, so returning state (not throwing) is the contract.
export async function removeSsoProvider(
  providerId: string,
): Promise<{ error?: string }> {
  // Defense in depth: the surface is already entitlement-gated, but a server
  // action is independently reachable, so gate it here too.
  if (!(await hasEntitlement("sso"))) {
    return { error: "Single sign-on isn’t available on your plan." };
  }

  const gate = await requireManager("Only an owner or admin can change SSO.");
  if ("error" in gate) return { error: gate.error };

  // Scope the delete to BOTH the provider id and the acting org so one org can
  // never remove another's project.
  await getDb(bootRegion())
    .delete(ssoProvider)
    .where(
      and(
        eq(ssoProvider.providerId, providerId),
        eq(ssoProvider.organizationId, gate.orgId),
      ),
    );
  return {};
}
