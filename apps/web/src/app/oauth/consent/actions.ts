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
import { oauthApplication, verification } from "@midplane-cloud/db/auth-schema";
import { safeErrorDetail } from "@midplane-cloud/router";

import { analyticsGroups, captureError } from "@/lib/analytics";
import { isPendingConsentRow } from "@/lib/consent-request";
import { currentCustomer } from "@/lib/customer";
import { getOrgContext } from "@/lib/org-context";
import { getPostHog } from "@/lib/posthog";
import { setOAuthGrants } from "@/lib/scope-grants";
import { ensureConsentAttributionToken } from "@/lib/tokens";

export type ConsentGrantResult =
  | { ok: true; granted: number }
  | {
      ok: false;
      error: "unauthenticated" | "bad_request" | "internal" | "stale_request";
    };

/** Persist the consent picker's project + DB selection as the (client, user)
 *  grant set, BEFORE the client posts the consent decision. The selection binds
 *  the credential to `projectId` (one OAuth credential → one project). Ownership
 *  and project-membership are validated inside setOAuthGrants (foreign / tampered
 *  / off-project ids are dropped). An empty selection is valid — it writes zero
 *  grants, and the proxy then 403s the agent (the user approved the client but
 *  no databases).
 *
 *  `consentCode` gates the write on the authorization request still being
 *  pending — see assertPendingConsent. Without that gate a consent page whose
 *  code was already consumed still rewrote the grant set (replace-all) on a
 *  second Allow, so a stale tab could clobber a live agent's grants even though
 *  its own consent POST then 401'd. */
export async function writeConsentGrants(
  consentCode: string,
  clientId: string,
  projectId: string,
  selections: Array<{ projectDatabaseId: string; access: "read" | "write" }>,
): Promise<ConsentGrantResult> {
  if (typeof consentCode !== "string" || consentCode.length === 0) {
    return { ok: false, error: "bad_request" };
  }
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

  if (!(await isConsentPending(customer.region, consentCode, clientId, userId))) {
    return { ok: false, error: "stale_request" };
  }

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

/** Is `consentCode` still an unconsumed, unexpired authorization request that
 *  belongs to this user and client?
 *
 *  The oidc-provider plugin stores the pending request as a `verification` row
 *  keyed by the consent code, and CONSUMES it on a successful consent by
 *  rewriting the identifier to the freshly-minted authorization code and
 *  flipping `requireConsent` to false. So "the row is still findable under the
 *  consent code, unexpired, and still requires consent" is exactly the
 *  plugin's own precondition for accepting the decision — we check it here so
 *  the grant write can't outlive the request it belongs to.
 *
 *  Reading the plugin's table directly (rather than through Better Auth) mirrors
 *  what the consent page already does for `oauth_application`, and this is a
 *  strictly read-only precondition — the plugin still owns every write and
 *  re-validates the code itself when the decision is posted. Any race left
 *  between this check and the POST is sub-request-length, versus the unbounded
 *  window a parked tab had before.
 *
 *  Fails CLOSED: a missing row, unparseable value, mismatched subject, or any
 *  error means "not pending". */
async function isConsentPending(
  region: Parameters<typeof getDb>[0],
  consentCode: string,
  clientId: string,
  userId: string,
): Promise<boolean> {
  try {
    const rows = await getDb(region)
      .select({ value: verification.value, expiresAt: verification.expiresAt })
      .from(verification)
      .where(eq(verification.identifier, consentCode))
      .limit(1);
    return isPendingConsentRow(rows[0] ?? null, { clientId, userId });
  } catch {
    return false;
  }
}
