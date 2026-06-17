"use server";

// Server Actions for the connection-detail token surface. Mirrors the
// REST endpoints under /api/connections/[id]/tokens but is called
// directly from the dashboard's client components — fewer hops, the
// same lib (tokens.ts) is the source of truth for behavior either way.
//
// The REST surface still exists for programmatic callers (CLI / CI
// tooling); both routes share validation rules and error translation
// so the two paths stay consistent.

import { getOrgContext } from "@/lib/org-context";
import { revalidatePath } from "next/cache";

import { loadPepperFromKms } from "@midplane-cloud/kms/pepper";
import { mintMcpUrl } from "@midplane-cloud/router";

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
  connectionId: string,
  input: { name: string; expiresInDays: 30 | 90 | 365 | null },
): Promise<CreateTokenResult> {
  const customer = await currentCustomer();
  if (!customer) return { ok: false, error: "internal" };
  const { userId } = await getOrgContext();
  if (!userId) return { ok: false, error: "internal" };

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
    console.error(
      `[createTokenAction] no pepper for region '${customer.region}'`,
    );
    return { ok: false, error: "internal" };
  }
  const pepperBuf = peppers.get(firstKid)!;

  const { plan, caps } = await resolvePlan();

  try {
    const result = await createToken(
      customer,
      connectionId,
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
    // mintMcpUrl turns the bare plaintext (mp_live_…/mp_test_…) into the
    // full https://<region>.midplane.ai/mcp/<plaintext> URL the agent
    // pastes into Cursor. Returning the full URL keeps the client modal
    // off the URL-composition path; revalidatePath() refreshes the
    // server-rendered token list when the modal closes.
    const mcpUrl = mintMcpUrl(customer.region, result.plaintext, process.env);
    revalidatePath(`/connections/${connectionId}`);
    // Dashboard list shows an "agents" count per connection — bust it so a
    // freshly minted token bumps the number on the next visit.
    revalidatePath("/dashboard");

    getPostHog()?.capture({
      distinctId: userId,
      event: "token_created",
      properties: {
        token_id: result.id,
        connection_id: connectionId,
        region: customer.region,
        expires_in_days: input.expiresInDays,
        source: "dashboard",
      },
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
    return { ok: false, error: "internal" };
  }
}

/** Called by the per-row revoke confirm. Idempotent against
 *  already-revoked tokens (lib does the no-op branch). Returns the
 *  token id on success, or null when the token / connection is unknown
 *  or foreign — the client treats null as "the row vanished, refresh
 *  the page." */
export async function revokeTokenAction(
  connectionId: string,
  tokenId: string,
): Promise<{ ok: true; id: string } | { ok: false; error: "not_found" | "internal" }> {
  const customer = await currentCustomer();
  if (!customer) return { ok: false, error: "internal" };
  const { userId } = await getOrgContext();
  if (!userId) return { ok: false, error: "internal" };

  try {
    const result = await revokeToken(customer, connectionId, tokenId, {
      reason: "user_action",
      actorUserId: userId,
    });
    if (!result) return { ok: false, error: "not_found" };
    revalidatePath(`/connections/${connectionId}`);
    // Keep the dashboard's "agents" count in sync after a revoke.
    revalidatePath("/dashboard");

    getPostHog()?.capture({
      distinctId: userId,
      event: "token_revoked",
      properties: {
        token_id: result.id,
        connection_id: connectionId,
        region: customer.region,
        source: "dashboard",
      },
    });

    return { ok: true, id: result.id };
  } catch (err) {
    console.error("[revokeTokenAction] unexpected failure", err);
    return { ok: false, error: "internal" };
  }
}
