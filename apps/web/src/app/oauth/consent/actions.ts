"use server";

// Server action for the OAuth consent project + DB picker. The Better Auth
// consent endpoint only grants the requested OAuth scope (`mcp`) — it can't
// carry a user-chosen project + per-DB selection — so the picker writes the
// selection to the mcp_scope_grants side table FIRST (keyed by the OAuth client
// + the signed-in user), and THEN the client posts /api/auth/oauth2/consent to
// complete the grant. The proxy enforces these rows on every MCP request
// (resolveScope → X-Midplane-Scope) and resolves the credential's bound project
// from them for the region-wide /mcp endpoint. Replace-all semantics: this
// selection IS the agent's whole grant set for this client — one credential is
// bound to ONE project.

import { currentCustomer } from "@/lib/customer";
import { getOrgContext } from "@/lib/org-context";
import { setOAuthGrants } from "@/lib/scope-grants";

export type ConsentGrantResult =
  | { ok: true; granted: number }
  | { ok: false; error: "unauthenticated" | "bad_request" | "internal" };

/** Persist the consent picker's project + DB selection as the (client, user)
 *  grant set, BEFORE the client posts the consent decision. The selection binds
 *  the credential to `projectId` (one OAuth credential → one project). Ownership
 *  and project-membership are validated inside setOAuthGrants (foreign / tampered
 *  / off-project ids are dropped). An empty selection is valid — it writes zero
 *  grants, and the proxy then 403s the agent (the user approved the client but
 *  no databases). */
export async function writeConsentGrants(
  clientId: string,
  projectId: string,
  selections: Array<{ projectDatabaseId: string; access: "read" | "write" }>,
): Promise<ConsentGrantResult> {
  if (typeof clientId !== "string" || clientId.length === 0) {
    return { ok: false, error: "bad_request" };
  }
  if (typeof projectId !== "string" || projectId.length === 0) {
    return { ok: false, error: "bad_request" };
  }
  if (!Array.isArray(selections)) return { ok: false, error: "bad_request" };

  const customer = await currentCustomer();
  if (!customer) return { ok: false, error: "unauthenticated" };
  const { userId } = await getOrgContext();
  if (!userId) return { ok: false, error: "unauthenticated" };

  try {
    const granted = await setOAuthGrants(customer, {
      clientId,
      userId,
      projectId,
      selections,
    });
    return { ok: true, granted };
  } catch (err) {
    console.error("[writeConsentGrants] failed", err);
    return { ok: false, error: "internal" };
  }
}
