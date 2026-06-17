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
import { isSelfHost } from "./src/lib/self-host.ts";

export async function register() {
  const region = process.env.MIDPLANE_REGION ?? "<unset>";
  // Boot log is JSON to match the middleware's structured-warn format so
  // downstream log search can grep on "event": values.
  console.log(
    JSON.stringify({
      level: "info",
      event: "region.boot",
      region: isSelfHost() ? "self-host" : region,
      ts: new Date().toISOString(),
    }),
  );
  assertBootEnv();

  // Self-host: seed the implicit org + customer the single-tenant build binds
  // every customer_id-scoped transaction against, before the first request can
  // reach a bind. The NEXT_RUNTIME guard is REQUIRED: register() runs in both
  // the Node.js and Edge runtimes, and customer.ts pulls node:async_hooks /
  // node:crypto (via getDb), which the Edge bundle can't load. Guarding on
  // 'nodejs' keeps that import out of the Edge compilation entirely. The
  // dynamic import also keeps the cloud boot path db-free.
  if (process.env.NEXT_RUNTIME === "nodejs" && isSelfHost()) {
    const { ensureImplicitCustomer } = await import("./src/lib/customer.ts");
    await ensureImplicitCustomer();
  }
}
