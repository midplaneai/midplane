import { PostHog } from "posthog-node";

import { scrubPostHogEvent } from "./posthog-scrub.ts";

// Singleton PostHog client for server-side event capture.
// Long-running Next.js process — batching defaults are intentional (do not
// set flushAt=1 or flushInterval=0, which are for short-lived processes only).
let _client: PostHog | null = null;

export function getPostHog(): PostHog | null {
  const apiKey = process.env.POSTHOG_API_KEY;
  const host = process.env.POSTHOG_HOST;
  if (!apiKey || !host) return null;

  if (!_client) {
    _client = new PostHog(apiKey, {
      host,
      // Server-side exception tracking. This is the control plane ONLY — the
      // OSS engine (Bun, compiled binary, MIT, self-hosted) never imports
      // posthog and must not phone home; its telemetry is governed separately
      // by engine/TELEMETRY.md.
      enableExceptionAutocapture: true,
      // Mandatory PII/secret floor on EVERY outbound event. Without this,
      // autocaptured exceptions can carry the plaintext DSN, masking salt,
      // token peppers, or session bearers to a third party — the exact data
      // this product exists to protect. See ./posthog-scrub.ts.
      before_send: scrubPostHogEvent,
      // Code-variable (local-variable) capture is left OFF on purpose: it would
      // snapshot locals like `dsn`/`salt` into stack frames. Do not enable it
      // without extending the scrubber's mask coverage first.
    });
  }
  return _client;
}

// Residual / ops notes (not enforced in code):
//   - DB error TEXT from the proxy/dry-run paths may still embed schema
//     identifiers (e.g. `relation "x" does not exist`). The durable fix is to
//     wrap those as opaque errors at the proxy boundary; the scrubber only
//     guarantees the secret/DSN floor.
//   - Data residency: POSTHOG_HOST must point at the region-appropriate PostHog
//     instance (EU for EU traffic) so error events honor the same EU/US split
//     as the rest of the control plane.
//   - Belt-and-suspenders: enable PostHog's project-level property filters as a
//     server-side second layer behind this client-side scrubber.
