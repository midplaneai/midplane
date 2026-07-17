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

import { and, eq } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { oauthApplication } from "@midplane-cloud/db/auth-schema";
import { safeErrorDetail } from "@midplane-cloud/router";

import { analyticsGroups, captureError } from "@/lib/analytics";
import { currentCustomer } from "@/lib/customer";
import { getOrgContext } from "@/lib/org-context";
import { getPostHog } from "@/lib/posthog";
import { setOAuthGrants } from "@/lib/scope-grants";
import { ensureConsentAttributionToken } from "@/lib/tokens";

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

  // clientId is free text with no FK — require a registered (DCR) OAuth
  // application, and not an operator-disabled one, before writing grants or
  // minting the attribution row: a direct call with a fabricated or disabled
  // id must not create phantom "agent" rows in the agent list / dashboard
  // counts. The consent page only ever submits real ids; this is the
  // tamper-path backstop.
  const knownClient = await getDb(customer.region)
    .select({ clientId: oauthApplication.clientId })
    .from(oauthApplication)
    .where(
      and(
        eq(oauthApplication.clientId, clientId),
        eq(oauthApplication.disabled, false),
      ),
    )
    .limit(1);
  if (knownClient.length === 0) return { ok: false, error: "bad_request" };

  try {
    const granted = await setOAuthGrants(customer, {
      clientId,
      userId,
      projectId,
      selections,
    });
    // Mint (or restore) the (project, client) attribution row at consent time —
    // the Connect pane's live status reads it as "agent connected", and a
    // zero-database grant leaves no other durable trace (no scope rows, and the
    // proxy's lazy mint never runs because the credential resolves no project).
    // Also clears the revoked state on re-approval of a revoked agent.
    await ensureConsentAttributionToken(customer, {
      projectId,
      clientId,
      userId,
    });

    // The OAuth-first connect moment — the web flow mints no default token,
    // so token_created never sees interactive agents; this is the funnel
    // step between project setup and the first query_decided.
    // `granted: 0` is a real state (client approved, zero DBs → proxy 403s).
    getPostHog()?.capture({
      distinctId: userId,
      event: "agent_connected",
      properties: {
        method: "oauth",
        client_id: clientId,
        project_id: projectId,
        granted_databases: granted,
        region: customer.region,
      },
      groups: analyticsGroups({ customerId: customer.id, projectId }),
    });

    return { ok: true, granted };
  } catch (err) {
    console.error("[writeConsentGrants] failed", err);
    // Synthesized: constraint DETAIL can embed row values — console keeps
    // the raw error, the tracker gets the opaque class.
    captureError("oauth.consent_grant_failed", new Error(safeErrorDetail(err)), {
      distinctId: userId,
      properties: {
        client_id: clientId,
        project_id: projectId,
        customer_id: customer.id,
      },
    });
    return { ok: false, error: "internal" };
  }
}
