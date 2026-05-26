import { PostHog } from "posthog-node";

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
      enableExceptionAutocapture: true,
    });
  }
  return _client;
}
