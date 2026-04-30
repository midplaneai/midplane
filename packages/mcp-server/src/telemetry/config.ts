// Env-var → typed TelemetryConfig.
//
// Precedence (off wins): DO_NOT_TRACK=1 → disabled. Otherwise:
//   MIDPLANE_TELEMETRY=0|off|false → disabled
//   MIDPLANE_TELEMETRY=debug       → debug (stderr, no network)
//   anything else / unset          → enabled
//
// Endpoint defaults to https://t.midplane.ai/v1/events; the hostname stays
// stable across receiver swaps so customers don't need to reconfigure egress.

export type TelemetryMode = "enabled" | "disabled" | "debug";

export interface TelemetryConfig {
  mode: TelemetryMode;
  endpoint: string;
  heartbeatMs: number;       // default 86_400_000 (24h); MIDPLANE_TELEMETRY_HEARTBEAT_MS overrides for tests
  startupDelayMs: number;    // default 0; small jitter avoids stampedes against the receiver
}

const DEFAULT_ENDPOINT = "https://t.midplane.ai/v1/events";
const DEFAULT_HEARTBEAT_MS = 86_400_000;
// Min is 1ms — MIDPLANE_TELEMETRY_HEARTBEAT_MS is documented as a test hook
// and an operator setting it that low is intentional. Clamp at 0/negative
// only.
const MIN_HEARTBEAT_MS = 1;
const MAX_HEARTBEAT_MS = 7 * 86_400_000;

export function loadTelemetryConfig(env: NodeJS.ProcessEnv): TelemetryConfig {
  const mode = resolveMode(env);
  const endpoint = env.MIDPLANE_TELEMETRY_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
  const heartbeatMs = parseHeartbeatMs(env.MIDPLANE_TELEMETRY_HEARTBEAT_MS);
  const startupDelayMs = parseStartupDelayMs(env.MIDPLANE_TELEMETRY_STARTUP_DELAY_MS);
  return { mode, endpoint, heartbeatMs, startupDelayMs };
}

function resolveMode(env: NodeJS.ProcessEnv): TelemetryMode {
  // DO_NOT_TRACK is the industry standard. Any non-empty truthy-ish value
  // disables telemetry. We accept "1" and "true" (case-insensitive).
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt === "1" || dnt === "true") return "disabled";

  const raw = env.MIDPLANE_TELEMETRY?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "1" || raw === "true" || raw === "on") {
    return "enabled";
  }
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return "disabled";
  }
  if (raw === "debug") return "debug";

  // Unknown value → fail safe (disabled). The first-run notice is the
  // documented surface; we don't error the process for an env-var typo.
  return "disabled";
}

function parseHeartbeatMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_HEARTBEAT_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_HEARTBEAT_MS || n > MAX_HEARTBEAT_MS) {
    return DEFAULT_HEARTBEAT_MS;
  }
  return n;
}

function parseStartupDelayMs(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 60_000) return 0;
  return n;
}
