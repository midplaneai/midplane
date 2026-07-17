import { captureError, redactForCapture } from "./analytics.ts";
import { isSelfHost } from "./self-host.ts";

// Lifecycle email via Loops (https://loops.so). One job today: the founder
// welcome email, sent by a Loops loop triggered on the `signup` event fired
// from the signup completion path. Loops owns the template and timing (copy
// iterates without a deploy); Resend (lib/email.ts) keeps the auth-critical
// transactional sends (invites, password reset). Same direct-fetch posture as
// lib/email.ts — one POST, no SDK.
//
// Cloud-only and env-gated: self-host never fires events, and cloud only does
// once LOOPS_API_KEY is set. The key deliberately stays UNSET until the
// privacy policy lists Loops as a processor — setting the env var is the
// launch switch for lifecycle email.

/** True when this process may send Loops events: cloud with the key set. */
export function isLoopsConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (isSelfHost()) return false;
  return Boolean(env.LOOPS_API_KEY);
}

/** Hard cap on the Loops round trip. The call sits on the signup completion
 *  path: never-throw covers failures, but only a timeout covers a HUNG
 *  endpoint (undici has no default per-request timeout) — without it a stuck
 *  Loops API would stall every new signup. */
const LOOPS_TIMEOUT_MS = 3_000;

/** Top-level events/send body fields with reserved semantics. Stripped from
 *  contactProperties before the spread so a property named like one of these
 *  can never take on API semantics (e.g. a `userId` property re-associating
 *  the contact) — the guard must hold for future callers, not just today's. */
const RESERVED_BODY_KEYS = new Set([
  "email",
  "userId",
  "eventName",
  "eventProperties",
  "mailingLists",
]);

/** Contact-property keys whose values are personal data and must be scrubbed
 *  from captured failure messages (providers echo payloads back in error
 *  bodies). Deliberately NOT all string values: redactForCapture replaces
 *  case-insensitive substrings, so scrubbing an enum like region ("us")
 *  mangles the diagnostics ("status" → "stat[redacted]"). */
const PII_CONTACT_KEYS = new Set(["firstName", "lastName", "name", "email"]);

/** Fire a Loops event for a contact (created on first event). Never throws —
 *  lifecycle email must not break the signup path it rides on; failures go to
 *  PostHog exception capture with the address redacted.
 *
 *  contactProperties are spread as TOP-LEVEL body fields (the events/send
 *  contract) and PERSIST on the contact — use them for segmentable state
 *  (e.g. region); eventProperties are per-event data for the triggered email.
 *  idempotencyKey guards double-fires: Loops dedupes it for 24h and returns
 *  409 on a replay, which we treat as success. */
export async function sendLoopsEvent(args: {
  email: string;
  userId?: string;
  eventName: string;
  eventProperties?: Record<string, string | number | boolean>;
  contactProperties?: Record<string, string | number | boolean>;
  idempotencyKey?: string;
}): Promise<void> {
  try {
    if (!isLoopsConfigured()) return;
    const contactProperties = Object.fromEntries(
      Object.entries(args.contactProperties ?? {}).filter(
        ([key]) => !RESERVED_BODY_KEYS.has(key),
      ),
    );
    const res = await fetch("https://app.loops.so/api/v1/events/send", {
      method: "POST",
      signal: AbortSignal.timeout(LOOPS_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${process.env.LOOPS_API_KEY}`,
        "Content-Type": "application/json",
        ...(args.idempotencyKey
          ? { "Idempotency-Key": args.idempotencyKey }
          : {}),
      },
      body: JSON.stringify({
        // Contact properties first (reserved keys stripped above) so the
        // fields below can never be shadowed.
        ...contactProperties,
        email: args.email,
        ...(args.userId ? { userId: args.userId } : {}),
        eventName: args.eventName,
        ...(args.eventProperties
          ? { eventProperties: args.eventProperties }
          : {}),
      }),
    });
    // 409 = replay of an idempotency key we actually sent — the event fired
    // once already, which is exactly what we want. Without a key, a 409 is
    // some other conflict and must be reported like any failure.
    const idempotentReplay = res.status === 409 && Boolean(args.idempotencyKey);
    if (!res.ok && !idempotentReplay) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Loops event send failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
  } catch (err) {
    // Redact what we submitted before capture: the message embeds the Loops
    // response body, and providers echo the payload back on validation
    // errors. Bare emails and names are outside the PostHog scrubber's
    // patterns, so scrub the address plus PII contact properties here.
    let message = redactForCapture(
      err instanceof Error ? err.message : String(err),
      args.email,
    );
    for (const [key, value] of Object.entries(args.contactProperties ?? {})) {
      if (PII_CONTACT_KEYS.has(key) && typeof value === "string") {
        message = redactForCapture(message, value);
      }
    }
    captureError("loops.event_send_failed", new Error(message), {
      properties: { event_name: args.eventName },
    });
  }
}
