// HTTPS POST sender. Fire-and-forget; failure is silent and never blocks
// a query. Debug mode replaces the network call with a stderr line so
// operators can audit exactly what would be sent.

import type { TelemetryConfig } from "./config.ts";
import { sanitize } from "./sanitizer.ts";
import type { TelemetryEvent } from "./schema.ts";

const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = "midplane-mcp-server-telemetry/1";

export interface Sender {
  send(event: TelemetryEvent): Promise<void>;
}

export function createSender(cfg: TelemetryConfig): Sender {
  if (cfg.mode === "disabled") {
    return { async send() {} };
  }
  if (cfg.mode === "debug") {
    return {
      async send(event) {
        const result = sanitize(event);
        if (!result.ok) {
          process.stderr.write(`[telemetry-debug] DROPPED ${result.reason}\n`);
          return;
        }
        process.stderr.write(`[telemetry-debug] ${result.serialized}\n`);
      },
    };
  }
  return new HttpSender(cfg.endpoint);
}

class HttpSender implements Sender {
  constructor(private readonly endpoint: string) {}

  async send(event: TelemetryEvent): Promise<void> {
    const result = sanitize(event);
    if (!result.ok) {
      // Sanitizer drop = a bug we want to know about during development,
      // but not noisy in production. Log to stderr without details that
      // could embed sensitive substrings (the reason itself is bounded).
      process.stderr.write(`[telemetry] dropped event: ${result.reason}\n`);
      return;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": USER_AGENT,
        },
        body: result.serialized,
        signal: ctrl.signal,
        keepalive: true,
      });
      // Status code is intentionally ignored. Receiver returns 204 on
      // accept and 4xx on rate-limit/validation; either way the client
      // moves on.
    } catch {
      // Network error, DNS failure, abort — all silent.
    } finally {
      clearTimeout(timer);
    }
  }
}
