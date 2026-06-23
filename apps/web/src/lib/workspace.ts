import { APIError } from "better-auth/api";
import { eq, sql } from "drizzle-orm";

import { customers, getDb, indexerCursors, projects } from "@midplane-cloud/db";
import {
  member,
  organization,
  subscription as subscriptionTable,
} from "@midplane-cloud/db/auth-schema";

import { hasLiveSubscription } from "./billing.ts";
import { classifyAccountDeletion, type OrgRole } from "./org-roles.ts";
import { bootRegion } from "./region-context.ts";
import { isSelfHost } from "./self-host.ts";

// Workspace (organization) teardown — the destructive side of account deletion.
// Driven by Better Auth's deleteUser flow: the user.deleteUser.beforeDelete hook
// in lib/auth.ts calls handleBeforeUserDelete BEFORE the user row is removed, so
// this is where the "what happens to the workspace" rule (lib/org-roles.ts
// classifyAccountDeletion) is enforced and acted on.

/** Tear a workspace down completely: stop its engine containers and delete its
 *  data. Called when the SOLE member of a workspace deletes their account —
 *  there's no one left to own it.
 *
 *  Billing is NOT touched here. Deletion is refused upstream while the org has a
 *  live subscription (handleBeforeUserDelete + the account page), so by the time
 *  we reach teardown the user has already cancelled their plan through the
 *  normal billing flow — there's nothing left to bill, and we never risk a
 *  deleted account paired with a live subscription.
 *
 *  Order: stop containers (best-effort), then ONE atomic DB transaction. The
 *  projects→customers FK is RESTRICT, not CASCADE, so projects are deleted
 *  EXPLICITLY before the customer row; deleting a project DOES cascade to its
 *  project_databases + mcp_tokens (the KMS-encrypted DSNs live there, so the
 *  ciphertext goes with them). */
export async function tearDownWorkspace(orgId: string): Promise<void> {
  const db = getDb(bootRegion());

  // The org's customer row (region-resident, 1:1 with the org). Absent only if
  // onboarding half-failed before it was written — then there are no projects
  // or credentials to tear down, just the org/subscription rows at the end.
  const cust = (
    await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.orgId, orgId))
      .limit(1)
  )[0];

  // 1. Stop any running engine containers for this customer's projects, keyed
  //    on project id (best-effort, mirroring the project-delete route). Done
  //    BEFORE the DB delete while we still know the project ids. The proxy
  //    module is imported lazily so it isn't pulled into auth.ts's module graph
  //    just by wiring the beforeDelete hook.
  if (cust) {
    const projectRows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.customerId, cust.id));
    if (projectRows.length > 0) {
      const { getMcpProxyContext } = await import("./mcp-proxy.ts");
      const ctx = getMcpProxyContext();
      for (const p of projectRows) {
        await ctx.registry.invalidate(p.id).catch((err) => {
          console.error(
            "[workspace teardown] registry.invalidate failed",
            p.id,
            err,
          );
        });
      }
    }
  }

  // 2. Delete the workspace's data in ONE transaction so the DB teardown is
  //    all-or-nothing. The projects→customers FK is RESTRICT, so projects must
  //    be deleted EXPLICITLY before the customer row (deleting a project
  //    cascades to its project_databases + mcp_tokens, and SET NULLs the
  //    project_id on indexer_cursors / audit rows). We then sweep the
  //    customer's cursors by customer_id, the same way deleteProject does.
  //    subscription has no FK to the org (keyed by referenceId); deleting the
  //    organization CASCADEs its member / invitation / sso_provider rows.
  //    NOTE: audit_events_index rows (customer_id, RLS-scoped, no FK) are NOT
  //    purged here — unreachable once the customer row is gone (no session can
  //    bind that customer_id), so they're left to a future RLS-scoped
  //    audit-retention sweep rather than deleted on this path.
  await db.transaction(async (tx) => {
    if (cust) {
      await tx.delete(projects).where(eq(projects.customerId, cust.id));
      await tx
        .delete(indexerCursors)
        .where(eq(indexerCursors.customerId, cust.id));
      await tx.delete(customers).where(eq(customers.id, cust.id));
    }
    await tx
      .delete(subscriptionTable)
      .where(eq(subscriptionTable.referenceId, orgId));
    await tx.delete(organization).where(eq(organization.id, orgId));
  });
}

/** Better Auth `user.deleteUser.beforeDelete` backstop. Runs server-side after
 *  Better Auth has verified the caller's intent (password or fresh session) and
 *  BEFORE the user row is deleted. Enforces the account-deletion rule for every
 *  org the user belongs to:
 *
 *   - owner of a workspace with other members → throw (the UI blocks this too,
 *     but a direct API call must be refused — we never orphan a shared
 *     workspace);
 *   - sole member → tear the workspace down;
 *   - non-owner → nothing; Better Auth removes the member row via cascade when
 *     it deletes the user.
 *
 *  Self-host has one implicit owner whose deletion would brick the instance, so
 *  account deletion is refused there outright. */
export async function handleBeforeUserDelete(userId: string): Promise<void> {
  if (isSelfHost()) {
    throw new APIError("BAD_REQUEST", {
      message: "Account deletion isn’t available on self-hosted instances.",
    });
  }

  const db = getDb(bootRegion());
  const memberships = await db
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId));

  for (const m of memberships) {
    const total =
      (
        await db
          .select({ count: sql<number>`count(*)::int` })
          .from(member)
          .where(eq(member.organizationId, m.organizationId))
      )[0]?.count ?? 0;

    const plan = classifyAccountDeletion({
      role: m.role as OrgRole,
      otherMemberCount: Math.max(0, total - 1),
    });

    if (plan === "blocked-owner") {
      throw new APIError("BAD_REQUEST", {
        message:
          "You own a workspace with other members. Hand off ownership or remove the other members before deleting your account.",
      });
    }
    if (plan === "delete-workspace") {
      // Refuse while a subscription is live. The user cancels their plan through
      // billing first, so deleting the workspace never strands a paying Stripe
      // subscription on data that's about to vanish. (The account page shows the
      // same block; this is the server backstop.)
      if (await hasLiveSubscription(m.organizationId)) {
        throw new APIError("BAD_REQUEST", {
          message:
            "Cancel your subscription in billing before deleting your account.",
        });
      }
      await tearDownWorkspace(m.organizationId);
    }
    // "leave": nothing to do — the member row cascades with the user delete.
  }
}
