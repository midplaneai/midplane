// Next.js instrumentation hook — runs once at process boot.
//
// Logs the regional pinning so a deploy that boots with the wrong
// MIDPLANE_REGION (or none) surfaces in the first log line, instead of
// going silently and only revealing itself when a getDb call throws.
//
// Also runs `assertBootEnv()`, which collects every required env var
// for the current process shape and throws once with the full list.
// Without this, a missing var (e.g. MIDPLANE_TOKEN_PEPPER_EU_V1) only
// surfaces when the first request reaches the code path that reads it.
//
// Intentionally minimal — does not import the db client (cf. /api/health
// design rationale: no DB touch in the liveness path).

import { assertBootEnv } from "./src/lib/assert-boot-env.ts";

export function register() {
  const region = process.env.MIDPLANE_REGION ?? "<unset>";
  // Boot log is JSON to match the middleware's structured-warn format so
  // downstream log search can grep on "event": values.
  console.log(
    JSON.stringify({
      level: "info",
      event: "region.boot",
      region,
      ts: new Date().toISOString(),
    }),
  );
  assertBootEnv();
}
