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
// LOCATION MATTERS: this file MUST live at src/instrumentation.ts, not the
// package root. Next.js only discovers `instrumentation` inside src/ when the
// app uses a src/ layout (this one does: src/app, src/middleware.ts). The
// Turbopack dev server is lax enough to also pick up a root-level file, but
// `next build` (webpack) does NOT — a root instrumentation.ts compiles to
// nothing in the standalone output, so register() never runs in production.
// That silently un-seeds the self-host implicit customer below and bricks the
// first signup (P0). Keep it in src/.
//
// Intentionally minimal — does not import the db client (cf. /api/health
// design rationale: no DB touch in the liveness path).

import type { Instrumentation } from "next";
import type { Region } from "@midplane-cloud/kms";

import { assertBootEnv } from "./lib/assert-boot-env.ts";
import { isSelfHost, SELF_HOST_REGION } from "./lib/self-host.ts";

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

  // KMS liveness. assertBootEnv only checks the KMS env vars are PRESENT, not
  // that they actually encrypt. Do one real encrypt for the pinned region so a
  // present-but-invalid AWS key (or an IAM policy scoped to the alias ARN
  // instead of the key ARN) fails the DEPLOY here — instead of silently 500ing
  // every add-database and DSN decrypt at runtime, as the US region once did.
  // nodejs-only + dynamic import: the AWS SDK must never enter the Edge bundle
  // (same guard rationale as the db/ee/posthog imports below).
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const kmsRegion: Region = isSelfHost()
      ? SELF_HOST_REGION
      : (process.env.MIDPLANE_REGION as Region);
    const { assertKmsLiveness } = await import("./lib/assert-kms-liveness.ts");
    await assertKmsLiveness(kmsRegion);
    console.log(
      JSON.stringify({
        level: "info",
        event: "kms.liveness_ok",
        region: kmsRegion,
        ts: new Date().toISOString(),
      }),
    );
  }

  // Flush PostHog's buffered events on shutdown — posthog-node batches
  // (flushAt/flushInterval), so without this the buffered tail (often the
  // low-volume business events sitting below flushAt) is dropped on every
  // deploy. BOTH signals on purpose: Fly's default kill_signal is SIGINT
  // (neither web TOML overrides it), and Next.js handles SIGINT by
  // draining + process.exit — a SIGTERM-only handler would simply never
  // run in the hosted cloud. Best-effort with a short timeout inside the
  // stop grace period; races Next's own shutdown, which is fine — a
  // partial flush beats none. nodejs-only: posthog-node can't load on Edge.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const flushPosthog = () => {
      void import("./lib/posthog.ts")
        .then(({ getPostHog }) => getPostHog()?.shutdown(3_000))
        .catch(() => undefined);
    };
    process.on("SIGTERM", flushPosthog);
    process.on("SIGINT", flushPosthog);
  }

  // Self-host: seed the implicit org + customer the single-tenant build binds
  // every customer_id-scoped transaction against, before the first request can
  // reach a bind. The NEXT_RUNTIME guard is REQUIRED: register() runs in both
  // the Node.js and Edge runtimes, and customer.ts pulls node:async_hooks /
  // node:crypto (via getDb), which the Edge bundle can't load. Guarding on
  // 'nodejs' keeps that import out of the Edge compilation entirely. The
  // dynamic import also keeps the cloud boot path db-free.
  if (process.env.NEXT_RUNTIME === "nodejs" && isSelfHost()) {
    const { ensureImplicitCustomer } = await import("./lib/customer.ts");
    await ensureImplicitCustomer();
  }

  // Enterprise Edition bootstrap — the SOLE bridge from the always-present graph
  // into ee/. It registers the ee Better Auth plugins (SSO/SAML) into the
  // neutral registry that createAuth() reads synchronously on the first request.
  // Runs once at boot, before any request builds auth.
  //
  // Triple-guarded: nodejs only (ee pulls Node-only SAML deps; never enter the
  // Edge bundle), MIDPLANE_EE=1 (so keyless cloud / self-host never load it), and
  // try/caught (so a community build that physically deletes src/ee/ still boots
  // — the import just fails and SSO stays dark). registerEe() self-gates on
  // eeEnabled() too.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.MIDPLANE_EE === "1") {
    try {
      // Non-literal specifier ON PURPOSE, doing triple duty now that this file
      // lives under src/ (compiled by `next build`, and covered by the open-core
      // eslint boundary):
      //   1. A `: string`-typed value keeps ee/ out of TypeScript's module graph
      //      (no "cannot find module" when src/ee/ is deleted for an MIT build).
      //   2. A template literal (not a string literal) slips past
      //      no-restricted-imports, so the MIT-core→ee ban doesn't false-positive.
      //   3. The static prefix is "./ee/register." — NOT a bare "./ee/" — so the
      //      lazy context webpack derives for this dynamic import globs only
      //      ee/register.* (the entrypoint + its deps). A bare "./ee/" context
      //      would sweep in ee/'s non-code governance files (LICENSE, README.md)
      //      and fail the build with "no loader to handle this file type". Keep
      //      the "register." in the static part.
      // With ee/ present this resolves ee/register.ts and calls registerEe().
      const eeExt: string = "ts";
      const mod = (await import(`./ee/register.${eeExt}`)) as {
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

// Next.js request-error hook — fires for every error thrown in a route handler,
// server action, or server component render. Next CATCHES these before they
// reach the process-level uncaughtException handler that posthog-node's
// enableExceptionAutocapture installs, so without this hook the bulk of
// production 500s never become PostHog $exception issues. Autocapture stays on
// for genuine process crashes; the two paths are disjoint (no double-capture).
//
// nodejs-guarded + dynamic import for the same reason register() guards its db
// and ee imports: posthog-node pulls Node-only builtins (fs/os) and must never
// enter the Edge bundle. onRequestError runs in whichever runtime threw, so an
// Edge/middleware error is skipped here (posthog-node can't run there) — an
// accepted gap; route handlers, actions, and RSC render in nodejs.
//
// Must never throw — it runs inside Next's error path, so everything is wrapped
// and the client is best-effort. captureException routes through the same
// before_send scrubber as every other event (see ./lib/posthog.ts), so the
// request path/method attached below are sanitized like any other property.
export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getPostHog } = await import("./lib/posthog.ts");
    const posthog = getPostHog();
    if (!posthog) return;
    posthog.captureException(error, undefined, {
      path: request.path,
      method: request.method,
      router_kind: context.routerKind,
      route_path: context.routePath,
      route_type: context.routeType,
      render_source: context.renderSource,
      revalidate_reason: context.revalidateReason,
      region: process.env.MIDPLANE_REGION,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "posthog.capture_exception_failed",
        reason: err instanceof Error ? err.message : String(err),
        ts: new Date().toISOString(),
      }),
    );
  }
};
