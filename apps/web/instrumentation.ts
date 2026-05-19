// Next.js instrumentation hook — runs once at process boot.
//
// Logs the regional pinning so a deploy that boots with the wrong
// MIDPLANE_REGION (or none) surfaces in the first log line, instead of
// going silently and only revealing itself when a getDb call throws.
//
// Intentionally minimal — does not import the db client (cf. /api/health
// design rationale: no DB touch in the liveness path).

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
}
