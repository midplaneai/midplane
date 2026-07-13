"use server";

// Server Actions for the project-detail token surface. Mirrors the
// REST endpoints under /api/projects/[id]/tokens but is called
// directly from the dashboard's client components — fewer hops, the
// same lib (tokens.ts) is the source of truth for behavior either way.
//
// The REST surface still exists for programmatic callers (CLI / CI
// tooling); both routes share validation rules and error translation
// so the two paths stay consistent.

import { getActiveRole, isManagerRole } from "@/lib/org-auth";
import { getOrgContext } from "@/lib/org-context";
import { revalidatePath } from "next/cache";

import { loadPepperFromKms } from "@midplane-cloud/kms/pepper";
import { mintMcpUrl, safeErrorDetail } from "@midplane-cloud/router";

import { analyticsGroups, captureError } from "@/lib/analytics";
import { currentCustomer } from "@/lib/customer";
import { PlanLimitError, resolvePlan, UPGRADE_URL } from "@/lib/plan";
import { getPostHog } from "@/lib/posthog";
import { tokenEnvFromConfig } from "@/lib/token-env";
import {
  DuplicateTokenName,
  ExpiryInThePast,
  createToken,
  revokeToken,
} from "@/lib/tokens";
import { setTokenGrants } from "@/lib/scope-grants";

const MAX_TOKEN_NAME_LENGTH = 64;

/** UX-friendly typed failures the client modal can render inline.
 *  `mcpUrl` carries the full URL (region host + plaintext) so the client
 *  never composes one — the show-once surface gets a value it can
 *  render directly. */
export type CreateTokenResult =
  | { ok: true; mcpUrl: string; id: string; name: string }
  | { ok: false; error: "name_required" | "name_too_long" | "name_taken" | "not_found" | "expiry_in_past" | "internal" }
  | { ok: false; error: "plan_limit"; limit: number; upgradeUrl: string };

const VALID_EXPIRY_DAYS = new Set([30, 90, 365]);

/** Called by the create-token modal's form. Returns a discriminated
 *  union the client can switch on — `ok: true` carries the plaintext
 *  (shown ONCE in the modal's success surface), `ok: false` carries a
 *  string code the client renders as inline form copy. */
export async function createTokenAction(
  projectId: string,
  input: {
    name: string;
    expiresInDays: 30 | 90 | 365 | null;
    // Per-agent DB scope (P6.1), keyed to the new token. Each entry is a DB of
    // THIS project at the granted access. Empty/omitted → no grant rows →
    // the token is unscoped (full access), the back-compat path for
    // API-created tokens. The dashboard picker always sends a non-empty scope.
    scope?: Array<{ projectDatabaseId: string; access: "read" | "write" }>;
  },
): Promise<CreateTokenResult> {
  const customer = await currentCustomer();
  if (!customer) return { ok: false, error: "internal" };
  const { userId } = await getOrgContext();
  if (!userId) return { ok: false, error: "internal" };

  // Minting tokens is an owner/admin capability. The headless-token surface is
  // hidden from members in the UI, so this guards the tamper path — members
  // connect agents via OAuth, which needs no minted token.
  if (!isManagerRole((await getActiveRole())?.role)) {
    console.warn("[createTokenAction] blocked: caller is not an owner/admin");
    return { ok: false, error: "internal" };
  }

  const trimmed = input.name.trim();
  if (trimmed.length === 0) return { ok: false, error: "name_required" };
  if (trimmed.length > MAX_TOKEN_NAME_LENGTH) {
    return { ok: false, error: "name_too_long" };
  }
  // Belt-and-suspenders: the client constrains expiresInDays via a
  // select, but a tampered submit could smuggle something else in.
  if (
    input.expiresInDays !== null &&
    !VALID_EXPIRY_DAYS.has(input.expiresInDays)
  ) {
    return { ok: false, error: "internal" };
  }

  const expiresAt =
    input.expiresInDays === null
      ? null
      : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const peppers = await loadPepperFromKms(customer.region, process.env);
  const firstKid = peppers.keys().next().value as string | undefined;
  if (!firstKid) {
    // Region-wide token minting is down (KMS/config) — swallowed as a
    // generic "internal" to the user, so capture is the only alert.
    console.error(
      `[createTokenAction] no pepper for region '${customer.region}'`,
    );
    captureError(
      "tokens.pepper_missing",
      new Error(`no pepper for region '${customer.region}'`),
      { distinctId: userId, properties: { customer_id: customer.id } },
    );
    return { ok: false, error: "internal" };
  }
  const pepperBuf = peppers.get(firstKid)!;

  const { plan, caps } = await resolvePlan();

  try {
    const result = await createToken(
      customer,
      projectId,
      {
        name: trimmed,
        expiresAt,
        actorUserId: userId,
        env: tokenEnvFromConfig(process.env),
        planLimit: { tokenCap: caps.tokens, plan },
      },
      { kid: firstKid, pepper: pepperBuf },
    );
    if (!result) return { ok: false, error: "not_found" };

    // Persist the token's DB scope (P6.1), keyed to the new token id. If this
    // fails we must NOT leave an unscoped (= full-access) token behind, so
    // compensate by revoking the just-created token and surfacing an error —
    // the user retries and gets a correctly-scoped token. Skipped when the
    // caller sent no scope (API/legacy path → unscoped by design).
    if (input.scope && input.scope.length > 0) {
      try {
        await setTokenGrants(customer, {
          mcpTokenId: result.id,
          projectId,
          selections: input.scope,
        });
      } catch (err) {
        console.error("[createTokenAction] scope write failed; revoking", err);
        // Synthesized: a Postgres constraint DETAIL embeds row VALUES
        // (customer-chosen names) — same rule as the proxy capture sites.
        captureError("tokens.scope_write_failed", new Error(safeErrorDetail(err)), {
          distinctId: userId,
          properties: {
            project_id: projectId,
            customer_id: customer.id,
            token_id: result.id,
          },
        });
        await revokeToken(customer, projectId, result.id, {
          reason: "user_action",
          actorUserId: userId,
        }).catch(() => undefined);
        return { ok: false, error: "internal" };
      }
    }

    // mintMcpUrl turns the bare plaintext (mp_live_…/mp_test_…) into the
    // full https://<region>.midplane.ai/mcp/<plaintext> URL the agent
    // pastes into Cursor. Returning the full URL keeps the client modal
    // off the URL-composition path; revalidatePath() refreshes the
    // server-rendered token list when the modal closes.
    const mcpUrl = mintMcpUrl(customer.region, result.plaintext, process.env);
    revalidatePath(`/projects/${projectId}`);
    // Dashboard list shows an "agents" count per project — bust it so a
    // freshly minted token bumps the number on the next visit.
    revalidatePath("/dashboard");

    getPostHog()?.capture({
      distinctId: userId,
      event: "token_created",
      properties: {
        token_id: result.id,
        project_id: projectId,
        region: customer.region,
        expires_in_days: input.expiresInDays,
        source: "dashboard",
      },
      groups: analyticsGroups({ customerId: customer.id, projectId }),
    });

    return { ok: true, mcpUrl, id: result.id, name: trimmed };
  } catch (err) {
    if (err instanceof DuplicateTokenName) {
      return { ok: false, error: "name_taken" };
    }
    if (err instanceof ExpiryInThePast) {
      return { ok: false, error: "expiry_in_past" };
    }
    if (err instanceof PlanLimitError) {
      return { ok: false, error: "plan_limit", limit: err.limit, upgradeUrl: UPGRADE_URL };
    }
    console.error("[createTokenAction] unexpected failure", err);
    captureError("tokens.create_failed", new Error(safeErrorDetail(err)), {
      distinctId: userId,
      properties: { project_id: projectId, customer_id: customer.id },
    });
    return { ok: false, error: "internal" };
  }
}

/** Called by the per-row revoke confirm. Idempotent against
 *  already-revoked tokens (lib does the no-op branch). Returns the
 *  token id on success, or null when the token / project is unknown
 *  or foreign — the client treats null as "the row vanished, refresh
 *  the page." */
export async function revokeTokenAction(
  projectId: string,
  tokenId: string,
): Promise<{ ok: true; id: string } | { ok: false; error: "not_found" | "internal" }> {
  const customer = await currentCustomer();
  if (!customer) return { ok: false, error: "internal" };
  const { userId } = await getOrgContext();
  if (!userId) return { ok: false, error: "internal" };

  // Revoking tokens is an owner/admin capability (tamper path — the UI is
  // hidden from members).
  if (!isManagerRole((await getActiveRole())?.role)) {
    console.warn("[revokeTokenAction] blocked: caller is not an owner/admin");
    return { ok: false, error: "internal" };
  }

  try {
    const result = await revokeToken(customer, projectId, tokenId, {
      reason: "user_action",
      actorUserId: userId,
    });
    if (!result) return { ok: false, error: "not_found" };
    revalidatePath(`/projects/${projectId}`);
    // Keep the dashboard's "agents" count in sync after a revoke.
    revalidatePath("/dashboard");

    getPostHog()?.capture({
      distinctId: userId,
      event: "token_revoked",
      properties: {
        token_id: result.id,
        project_id: projectId,
        region: customer.region,
        source: "dashboard",
      },
      groups: analyticsGroups({ customerId: customer.id, projectId }),
    });

    return { ok: true, id: result.id };
  } catch (err) {
    console.error("[revokeTokenAction] unexpected failure", err);
    captureError("tokens.revoke_failed", new Error(safeErrorDetail(err)), {
      distinctId: userId,
      properties: {
        project_id: projectId,
        customer_id: customer.id,
        token_id: tokenId,
      },
    });
    return { ok: false, error: "internal" };
  }
}
