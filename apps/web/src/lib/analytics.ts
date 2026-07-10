// Server-side analytics helpers layered over the PostHog singleton
// (./posthog.ts). Two jobs:
//
//   1. Group identity (launch-analytics spec §3): org- and project-level
//      PostHog groups so B2B funnels can segment by customer/plan. The
//      `organization` group is keyed on customers.id (NOT the Better Auth
//      orgId) because the audit indexer — the query-path emitter — only has
//      customer_id in scope; one key everywhere or group analytics fragments.
//   2. captureError: PostHog exception capture for the swallowed failure
//      sites (non-throwing 5xx returns, caught-and-logged catches) that
//      Next's onRequestError can never see. Tagged with a stable `site`
//      string so PostHog alerts can key on the failure class.
//
// Everything here is best-effort and self-host-safe: getPostHog() is null
// without POSTHOG_API_KEY/POSTHOG_HOST, and every helper no-ops on null.
// All payloads still pass the before_send scrubber (posthog-scrub.ts) —
// but the scrubber does NOT redact schema identifiers or email addresses,
// so callers must not put those in properties in the first place.

import { getPostHog } from "./posthog.ts";

/** PostHog `groups` object for an event. Omit nullish ids — an event with
 *  no org attribution (e.g. pre-signup) just carries no group. */
export function analyticsGroups(args: {
  customerId?: string | null;
  projectId?: string | null;
}): Record<string, string> {
  const groups: Record<string, string> = {};
  if (args.customerId) groups.organization = args.customerId;
  if (args.projectId) groups.project = args.projectId;
  return groups;
}

/** Register / refresh the org group's properties (plan, region). Called at
 *  signup and on every Stripe plan sync — plan lives HERE, not on each
 *  event, so the query path never pays a plan lookup. */
export function groupIdentifyOrganization(
  customerId: string,
  properties: { region: string; plan: string },
): void {
  try {
    getPostHog()?.groupIdentify({
      groupType: "organization",
      groupKey: customerId,
      properties,
    });
  } catch {
    // Never let group registration fail the success path it rides on.
  }
}

/** Register / refresh the project group. Idempotent — safe to call from
 *  every project-create/database-add site so pre-analytics projects get
 *  registered on first post-launch touch. */
export function groupIdentifyProject(
  projectId: string,
  properties: { region: string },
): void {
  try {
    getPostHog()?.groupIdentify({
      groupType: "project",
      groupKey: projectId,
      properties,
    });
  } catch {
    // Never let group registration fail the success path it rides on.
  }
}

/** Exception capture for swallowed failures. `site` is a stable
 *  dot-separated tag (e.g. "proxy.spawn_failed") — the alerting key.
 *  Never throws: telemetry must not break the request path it observes.
 *
 *  PII note: pass a synthesized `new Error(safeErrorDetail(err))` instead
 *  of the raw error wherever the raw one can wrap a Postgres connect error
 *  (customer DB host/user live outside the scrubber's URL patterns). */
export function captureError(
  site: string,
  error: unknown,
  opts?: {
    distinctId?: string;
    /** Set false when distinctId is a MACHINE id (mcp token id) — PostHog
     *  only auto-skips person processing when distinctId is absent, so a
     *  token-keyed capture would otherwise mint a junk person profile. */
    personProfile?: boolean;
    properties?: Record<string, unknown>;
  },
): void {
  try {
    const posthog = getPostHog();
    if (!posthog) return;
    posthog.captureException(
      error instanceof Error ? error : new Error(String(error)),
      opts?.distinctId,
      {
        ...(opts?.personProfile === false
          ? { $process_person_profile: false }
          : {}),
        site,
        region: process.env.MIDPLANE_REGION ?? null,
        ...opts?.properties,
      },
    );
  } catch {
    // Mirrors instrumentation.ts's posture: capture failures must never
    // surface into the path being observed. getPostHog() sits INSIDE the
    // try: a throwing client constructor (malformed env) must not escape
    // into the proxy error paths that call this without a wrapper.
  }
}

/** Redact a known sensitive literal (an email address, a token) from a
 *  message before capture — case-insensitively, every occurrence. Exact
 *  `replaceAll` is not enough: providers echo addresses back in
 *  normalized case ("Invalid recipient FOO@BAR.COM"), and bare emails are
 *  outside the before_send scrubber's patterns. */
export function redactForCapture(message: string, secret: string): string {
  if (!secret) return message;
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return message.replace(new RegExp(escaped, "gi"), "[redacted]");
}

/** Per-key time-window throttle for repeated-failure capture sites (e.g.
 *  the audit Indexer's onError, which fires every 5s tick while an engine
 *  is unreachable). Returns true when the caller should capture. Expired
 *  entries are pruned on each call so the map stays bounded by keys that
 *  failed within the current window — no per-project leak in the
 *  process-lifetime singleton. `now` is injectable for tests. */
export function makeCaptureThrottle(
  windowMs: number,
  now: () => number = Date.now,
): (key: string) => boolean {
  const lastCaptureAt = new Map<string, number>();
  return (key: string): boolean => {
    const t = now();
    for (const [k, at] of lastCaptureAt) {
      if (t - at >= windowMs) lastCaptureAt.delete(k);
    }
    if (lastCaptureAt.has(key)) return false;
    lastCaptureAt.set(key, t);
    return true;
  };
}
