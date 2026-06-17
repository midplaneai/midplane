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

  // Enterprise Edition bootstrap — the SOLE bridge from the always-present graph
  // into ee/. This file lives OUTSIDE src/ (exempt from the open-core eslint
  // boundary), so it is the sanctioned "cloud-only entrypoint": it registers the
  // ee Better Auth plugins (SSO/SAML) into the neutral registry that createAuth()
  // reads synchronously on the first request. Runs once at boot, before any
  // request builds auth.
  //
  // Triple-guarded: nodejs only (ee pulls Node-only SAML deps; never enter the
  // Edge bundle), MIDPLANE_EE=1 (so keyless cloud / self-host never load it), and
  // try/caught (so a community build that physically deletes src/ee/ still boots
  // — the import just fails and SSO stays dark). registerEe() self-gates on
  // eeEnabled() too.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.MIDPLANE_EE === "1") {
    try {
      // Non-literal specifier ON PURPOSE: a `: string`-typed value keeps ee/ out
      // of TypeScript's module graph (no "cannot find module" when src/ee/ is
      // deleted for an MIT build) while the static "./src/ee/" prefix lets the
      // bundler tolerate its absence too — so a deleted ee/ both type-checks and
      // compiles; the import just rejects at runtime and we catch it. With ee/
      // present this resolves register.ts normally.
      const eeEntry: string = "register.ts";
      const mod = (await import(`./src/ee/${eeEntry}`)) as {
        registerEe: () => void;
      };
      mod.registerEe();
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "ee.bootstrap_skipped",
          reason: err instanceof Error ? err.message : String(err),
          ts: new Date().toISOString(),
        }),
      );
    }
  }
}
