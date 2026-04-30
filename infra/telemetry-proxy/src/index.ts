// Midplane telemetry receiver. Fronts t.midplane.ai/v1/events, re-validates
// payloads against the locked OSS schema, and forwards to PostHog.
//
// Why this code lives in the closed cloud repo instead of OSS: it carries
// the PostHog project key, picks our analytics vendor, and is operated only
// by Midplane Inc. The wire contract (TELEMETRY.md, schema.ts) lives in the
// OSS repo at github.com/midplaneai/midplane and is the source of truth;
// src/schema.ts and src/sanitizer.ts here are byte-identical mirrors.

import { sanitize } from "./sanitizer.ts";
import type { TelemetryEvent } from "./schema.ts";

export interface Env {
  POSTHOG_HOST: string;
  POSTHOG_PROJECT_KEY?: string;
}

const FORWARD_TIMEOUT_MS = 5_000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/healthz") {
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }

    if (url.pathname !== "/v1/events" || request.method !== "POST") {
      return new Response(null, { status: 405 });
    }

    // Always 204 to clients past this point. Validation failures, malformed
    // JSON, missing secrets — all silent. A misbehaving client must learn
    // nothing about why we rejected.
    const body = await request.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return new Response(null, { status: 204 });
    }

    const result = sanitize(parsed);
    if (!result.ok) {
      return new Response(null, { status: 204 });
    }

    if (!env.POSTHOG_PROJECT_KEY) {
      return new Response(null, { status: 204 });
    }

    ctx.waitUntil(forwardToPostHog(result.event, env));
    return new Response(null, { status: 204 });
  },
} satisfies ExportedHandler<Env>;

async function forwardToPostHog(event: TelemetryEvent, env: Env): Promise<void> {
  // Hoist install_id → distinct_id, ts → timestamp; everything else into
  // properties. Note: we do NOT propagate cf-connecting-ip or any inbound
  // header — the outbound fetch carries no customer identifiers.
  const { install_id, ts, ...rest } = event;
  const payload = {
    api_key: env.POSTHOG_PROJECT_KEY,
    event: `midplane_${event.event}`,
    distinct_id: install_id,
    properties: rest,
    timestamp: new Date(ts * 1000).toISOString(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    await fetch(`${env.POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Silent. PostHog is the system of record; a 5s outage drops the event.
  } finally {
    clearTimeout(timer);
  }
}
