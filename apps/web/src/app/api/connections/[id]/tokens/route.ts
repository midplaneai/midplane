// GET  /api/connections/:id/tokens          — list this connection's tokens
// POST /api/connections/:id/tokens          — mint a new token
//
// Security posture (matches /api/connections/[id]/route.ts):
//   - The Clerk session is the ONLY authentication path. No service-token
//     shortcut.
//   - 404 — not 401/403 — when the connection is unknown OR belongs to a
//     different customer. Mirrors the lib's leakage-avoidance shape:
//     callers cannot distinguish "doesn't exist" from "exists for someone
//     else."
//   - Plaintext leaves this surface ONCE, in the POST 201 response body.
//     It is never logged, persisted in a server-side session, or returned
//     to GET. The caller is responsible for surfacing it.

import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { loadPepperFromKms } from "@midplane-cloud/kms/pepper";

import { currentCustomer } from "@/lib/customer";
import { PlanLimitError, planLimitBody, resolvePlan } from "@/lib/plan";
import { getPostHog } from "@/lib/posthog";
import { tokenEnvFromConfig } from "@/lib/token-env";
import {
  DuplicateTokenName,
  ExpiryInThePast,
  createToken,
  listTokens,
} from "@/lib/tokens";

const MAX_TOKEN_NAME_LENGTH = 64;

const CreateBody = z.object({
  name: z
    .string()
    .min(1, "name is required")
    .max(MAX_TOKEN_NAME_LENGTH, `name must be ${MAX_TOKEN_NAME_LENGTH} chars or fewer`)
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, "name is required"),
  // 30/90/365 days, or null for "never expires". Per the design doc,
  // these are the four customer-selectable options; an arbitrary
  // expires-in-days int is not accepted via the API (defense against
  // bookmark-able 36500-day tokens that defeat the rotation cadence).
  //
  // Coerce before validation so form-encoded clients (where every value
  // arrives as a string) get the same accept-set as JSON callers.
  // "30"/"90"/"365" → number; "" / "null" / "never" → null.
  expiresInDays: z.preprocess(
    coerceExpiresInDays,
    z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
  ),
});

function coerceExpiresInDays(val: unknown): unknown {
  if (val === null) return null;
  if (typeof val === "string") {
    if (val === "" || val === "null" || val === "never") return null;
    if (/^\d+$/.test(val)) return Number.parseInt(val, 10);
  }
  return val;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { id } = await params;
  const rows = await listTokens(customer, id);
  if (rows === null) {
    // Unknown connection OR owned by a different customer — same shape
    // either way to avoid leaking existence.
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ tokens: rows });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const customer = await currentCustomer();
  if (!customer) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "not signed in" }, { status: 401 });
  }
  const { id } = await params;

  let raw: unknown;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    raw = await req.json();
  } else {
    const form = await req.formData();
    raw = Object.fromEntries(form.entries());
  }
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const expiresAt =
    parsed.data.expiresInDays === null
      ? null
      : new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000);

  // V1 has exactly one pepper kid per region; createToken picks the
  // first entry as the active write-side kid. Rotation adds additional
  // kids that lookupByPlaintext tries in turn against existing rows.
  const peppers = await loadPepperFromKms(customer.region, process.env);
  const firstKid = peppers.keys().next().value as string | undefined;
  if (!firstKid) {
    throw new Error(
      `no pepper available for region '${customer.region}' — token mint cannot proceed`,
    );
  }
  const pepperBuf = peppers.get(firstKid)!;

  const { plan, caps } = await resolvePlan();

  let result;
  try {
    result = await createToken(
      customer,
      id,
      {
        name: parsed.data.name,
        expiresAt,
        actorClerkUserId: userId,
        env: tokenEnvFromConfig(process.env),
        planLimit: { tokenCap: caps.tokens, plan },
      },
      { kid: firstKid, pepper: pepperBuf },
    );
  } catch (err) {
    if (err instanceof DuplicateTokenName) {
      return Response.json(
        { error: "name_taken", takenName: err.takenName },
        { status: 409 },
      );
    }
    if (err instanceof PlanLimitError) {
      return Response.json(planLimitBody(err), { status: 402 });
    }
    if (err instanceof ExpiryInThePast) {
      // Should never reach here from this surface (we compute
      // expiresAt above), but if a clock skew or future code path
      // passes a stale Date, surface a 400 rather than a 500.
      return Response.json(
        { error: "expiry_in_past" },
        { status: 400 },
      );
    }
    throw err;
  }

  if (!result) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  getPostHog()?.capture({
    distinctId: userId,
    event: "token_created",
    properties: {
      token_id: result.id,
      connection_id: id,
      region: customer.region,
      expires_in_days: parsed.data.expiresInDays,
      source: "api",
    },
  });

  return Response.json(
    {
      id: result.id,
      plaintext: result.plaintext,
      name: parsed.data.name,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
    { status: 201 },
  );
}
