import type { EventMessage } from "posthog-node";

// PII / secret scrubber for everything we send to PostHog (events + the
// `$exception` events captured by `enableExceptionAutocapture`). Wired as the
// `before_send` hook in ./posthog.ts so it runs on EVERY outbound event,
// deliberate captures included.
//
// Why this exists: Midplane is a data-security product. An error tracker that
// ships exception messages, stack frames, and event properties to a third party
// can exfiltrate exactly what the product protects — most concretely the
// plaintext DSN that lives in a local at spawn time (proxy.ts: `dsn:
// decrypt.plaintext`), plus the masking salt, token peppers, and session
// bearers. This is the control-plane floor that mirrors the engine's bright
// line in engine/TELEMETRY.md ("What we never send"): DB URLs and their
// components, credentials, and secrets never leave the process in clear.
//
// Scope + non-goals:
//   - This is PATTERN + KEY-NAME redaction, not message nuking. The control
//     plane legitimately needs readable stack traces to debug, so free-form
//     messages are kept; only secret/credential SHAPES inside them are masked.
//   - It does NOT redact arbitrary schema identifiers (a Postgres error like
//     `relation "x" does not exist` surfaced from the proxy/dry-run paths can
//     still carry a table name). The durable fix for that is to wrap DB errors
//     as opaque at the proxy boundary; see the follow-up note in posthog.ts.
//   - Code-variable (local-variable) capture is a SEPARATE posthog-node opt-in
//     and is left OFF. If it is ever enabled, this scrubber is not sufficient on
//     its own — the local-variable mask patterns must cover dsn/salt/pepper too.

const REDACTED = "[redacted]";

// Property KEYS whose values are secrets/identifiers we never ship — the value
// is dropped wholesale regardless of its content. Substring, case-insensitive.
//
// Deliberately scoped:
//   - `conn…string` requires the "string" suffix so it matches `connectionString`
//     but NOT `connectionDatabaseId` (a non-sensitive id used in analytics).
//   - bare `token` is intentionally absent: token lifecycle events capture token
//     *ids* (`tok_…`) for funnels, and posthog-node does not carry the project
//     api key in `properties.token` (the posthog-js footgun). Actual token
//     *secrets* are caught by the value-pattern pass below instead.
const SENSITIVE_KEY =
  /(dsn|conn(?:ection)?[_-]?string|pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?key|priv(?:ate)?[_-]?key|salt|pepper|credential|authorization|bearer|cookie|session[_-]?token|master[_-]?(?:key|secret)|encryption[_-]?key)/i;

// String VALUE patterns redacted wherever they appear (messages, nested props,
// stack frames). Order matters only in that every match becomes REDACTED.
const VALUE_PATTERNS: ReadonlyArray<RegExp> = [
  // scheme://user:pass@host — any credentialed URL (covers postgres, redis, …).
  // user part is optional so `redis://:pass@host` matches too.
  /[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]+@\S+/gi,
  // Database URLs even without inline creds — the host/port/db are on the bright
  // line, so the whole URL goes.
  /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/\S+/gi,
  // JWTs (session/bearer tokens).
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // PostHog personal/project API keys (phc_/phx_/phs_…).
  /\bph[a-z]_[A-Za-z0-9]{10,}\b/g,
];

// `Bearer <token>` keeps the scheme so the shape stays legible in a trace.
const BEARER = /\bBearer\s+[A-Za-z0-9._-]+/gi;

function redactString(input: string): string {
  let out = input;
  for (const re of VALUE_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  return out;
}

// Plain object check: leave Date/RegExp/class instances untouched (iterating
// their entries would silently destroy them — e.g. a Date → {}).
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepScrub(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(deepScrub);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : deepScrub(child);
    }
    return out;
  }
  return value; // number, boolean, null, undefined, non-plain object
}

/**
 * `before_send` hook: scrub the event's `properties` (which is where
 * `$exception_list`, `$set`, and all custom props live) before it leaves the
 * process. Returns the event unchanged structurally — identifiers we own
 * (`distinctId`, `event`, `timestamp`, `uuid`) are intentionally preserved so
 * grouping and user attribution still work. Returning the event (never null)
 * keeps capture behavior identical; only the payload is sanitized.
 */
export function scrubPostHogEvent(
  event: EventMessage | null,
): EventMessage | null {
  if (!event || !event.properties) return event;
  return {
    ...event,
    properties: deepScrub(event.properties) as EventMessage["properties"],
  };
}
