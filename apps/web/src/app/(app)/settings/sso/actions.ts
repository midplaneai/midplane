"use server";

import { and, eq } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { member, ssoProvider } from "@midplane-cloud/db/auth-schema";

import { getOrgContext } from "@/lib/org-context";
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

  const { userId, orgId } = await getOrgContext();
  if (!userId || !orgId) return { error: "You’re not signed in." };

  const db = getDb(bootRegion());
  const role = (
    await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
  )[0]?.role;
  if (role !== "owner" && role !== "admin") {
    return { error: "Only an owner or admin can change SSO." };
  }

  // Scope the delete to BOTH the provider id and the acting org so one org can
  // never remove another's project.
  await db
    .delete(ssoProvider)
    .where(
      and(
        eq(ssoProvider.providerId, providerId),
        eq(ssoProvider.organizationId, orgId),
      ),
    );
  return {};
}
