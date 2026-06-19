import { and, eq } from "drizzle-orm";

import { customers, getDb } from "@midplane-cloud/db";
import { member } from "@midplane-cloud/db/auth-schema";

import { getActorEmail, getOrgContext } from "@/lib/org-context";
import {
  isManagerRole,
  isOwnerRole,
  type OrgRole,
} from "@/lib/org-roles";
import { bootRegion } from "@/lib/region-context";
import { resolveSelfHostAccess } from "@/lib/self-host-gate";
import {
  isSelfHost,
  SELF_HOST_CUSTOMER_ID,
  SELF_HOST_ORG_ID,
  SELF_HOST_REGION,
} from "@/lib/self-host";

// Org-role authorization — the single source of truth for "who can manage this
// workspace." The pure role helpers (isManagerRole / isAssignableRole /
// normalizeInviteRole and the OrgRole / AssignableRole types) live in
// lib/org-roles.ts and are re-exported below; this module adds the DB- and
// session-backed gates.
//
// Three enforcement seams, mirroring CLAUDE.md's "return state, don't throw"
// rule for server actions:
//   - requireManager()     → server actions reached from a form / client
//                            component that renders the returned { error }.
//   - assertManager()      → tamper-only paths (controls hidden from members,
//                            so a legitimate user never reaches the throw) and
//                            server components.
//   - requireManagerRest() → route handlers — returns a JSON 401/403 Response.
//
// Each surface is independently reachable, so the gate lives at the
// action/route, never only in the UI. Hiding a control is UX; this is the
// boundary.

export {
  ASSIGNABLE_ROLES,
  isAssignableRole,
  isManagerRole,
  isOwnerRole,
  normalizeInviteRole,
} from "@/lib/org-roles";
export type { AssignableRole, OrgRole } from "@/lib/org-roles";

export interface ActiveRole {
  userId: string;
  orgId: string;
  role: OrgRole;
}

/** The signed-in actor's role in the active org, or null when unauthenticated,
 *  org-less, or not a member of the active org. */
export async function getActiveRole(): Promise<ActiveRole | null> {
  // Self-host resolves against the fixed implicit org and mirrors
  // currentCustomer()'s owner-by-identity safety net (see below), so it's
  // handled on its own path rather than through getOrgContext's active org.
  if (isSelfHost()) return getSelfHostRole();

  const { userId, orgId } = await getOrgContext();
  if (!userId || !orgId) return null;
  const role = (
    await getDb(bootRegion())
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
  )[0]?.role as OrgRole | undefined;
  if (!role) return null;
  return { userId, orgId, role };
}

/** Self-host role resolution. The member row's role wins; but when it's absent
 *  the claimed owner is still resolved as `owner` — currentCustomer() grants
 *  that owner access by identity (a half-failed signup can leave the owner with
 *  no member row), and the role gates MUST mirror it or the safety-net owner
 *  loses manager nav + every project/token/audit action on their own instance.
 *  Everyone else (invited teammates) is bounded by their member row. */
async function getSelfHostRole(): Promise<ActiveRole | null> {
  const { userId } = await getOrgContext();
  if (!userId) return null;
  const db = getDb(SELF_HOST_REGION);
  const role = (
    await db
      .select({ role: member.role })
      .from(member)
      .where(
        and(
          eq(member.userId, userId),
          eq(member.organizationId, SELF_HOST_ORG_ID),
        ),
      )
      .limit(1)
  )[0]?.role as OrgRole | undefined;
  if (role) return { userId, orgId: SELF_HOST_ORG_ID, role };

  const ownerEmail =
    (
      await db
        .select({ ownerEmail: customers.ownerEmail })
        .from(customers)
        .where(eq(customers.id, SELF_HOST_CUSTOMER_ID))
        .limit(1)
    )[0]?.ownerEmail ?? null;
  const isClaimedOwner = resolveSelfHostAccess({
    isMember: false,
    sessionEmail: await getActorEmail(),
    ownerEmail,
  });
  return isClaimedOwner
    ? { userId, orgId: SELF_HOST_ORG_ID, role: "owner" }
    : null;
}

/** UI gating for server components: true when the caller may manage the
 *  workspace (owner/admin). */
export async function isManager(): Promise<boolean> {
  const ctx = await getActiveRole();
  return isManagerRole(ctx?.role);
}

/** True when the caller is the org owner. Owner-only capabilities (billing,
 *  later org deletion) gate on this rather than isManager. */
export async function isOwner(): Promise<boolean> {
  const ctx = await getActiveRole();
  return isOwnerRole(ctx?.role);
}

/** State-returning gate for server actions reached from a form / client
 *  component. Returns the org context on success, or { error } with a
 *  user-facing message (the contract those callers render inline). */
export async function requireManager(
  message = "Only an owner or admin can do this.",
): Promise<ActiveRole | { error: string }> {
  const ctx = await getActiveRole();
  if (!ctx) return { error: "You’re not signed in." };
  if (!isManagerRole(ctx.role)) return { error: message };
  return ctx;
}

/** Thrown by assertManager. `reason` distinguishes missing auth from an
 *  insufficient role; most callers don't need to branch on it. */
export class ManagerRequiredError extends Error {
  constructor(
    public readonly reason: "unauthenticated" | "forbidden",
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "ManagerRequiredError";
  }
}

/** Throwing gate for tamper-only paths (controls hidden from members, so a
 *  legitimate user never reaches the throw) and server components. */
export async function assertManager(): Promise<ActiveRole> {
  const ctx = await getActiveRole();
  if (!ctx) throw new ManagerRequiredError("unauthenticated");
  if (!isManagerRole(ctx.role)) throw new ManagerRequiredError("forbidden");
  return ctx;
}

/** Route-handler gate: the org context on success, or a JSON 401/403 Response
 *  ready to return. Mirrors the { error } / status shape the /api/projects
 *  routes already use. */
export async function requireManagerRest(): Promise<ActiveRole | Response> {
  const ctx = await getActiveRole();
  if (!ctx) return Response.json({ error: "not signed in" }, { status: 401 });
  if (!isManagerRole(ctx.role)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  return ctx;
}
