import type { BetterAuthPlugin } from "better-auth";

// The open-core seam for Enterprise (ee/) Better Auth plugins.
//
// THE PROBLEM: ee features (SSO/SAML) ship as Better Auth plugins, but the
// open-core boundary forbids MIT core (everything under src/, incl. lib/auth.ts)
// from importing ee/ — statically (eslint no-restricted-imports) or as a bundler
// dependency (deleting ee/ must leave a working MIT build). Yet betterAuth()
// needs its `plugins` array SYNCHRONOUSLY at construction, and getAuth() is sync
// and called at ~6 request sites (incl. withMcpAuth(getAuth(), …)).
//
// THE SEAM: this CORE module is a tiny registry with NO ee import. The ee build
// registers its plugins INTO it once at boot — instrumentation.ts (which lives
// OUTSIDE src/, the sanctioned cloud-only entrypoint) dynamically imports
// src/ee/register.ts under the MIDPLANE_EE flag, which calls
// registerEeAuthPlugins(). Next awaits instrumentation register() before serving
// any request, and createAuth() is lazy (first request), so getEeAuthPlugins()
// is always populated by the time auth is built — keeping getAuth() sync.
//
// Keyless cloud / self-host / a deleted ee/: register() is never called (the
// flag is off, or the import is caught), the registry stays empty, and the SSO
// plugin is simply absent. Core never names ee/ — only this neutral registry.

let eeAuthPlugins: BetterAuthPlugin[] = [];

/** Called once at boot (by the ee bootstrap, via instrumentation) to contribute
 *  the Enterprise Better Auth plugins. Replaces the registry wholesale so a
 *  re-run (e.g. a dev hot-reload re-invoking register()) is idempotent rather
 *  than additive. */
export function registerEeAuthPlugins(plugins: BetterAuthPlugin[]): void {
  eeAuthPlugins = plugins;
}

/** The Enterprise Better Auth plugins to splice into createAuth()'s plugin list
 *  — BEFORE nextCookies() (which must stay last). Empty unless the ee build
 *  registered them at boot. */
export function getEeAuthPlugins(): BetterAuthPlugin[] {
  return eeAuthPlugins;
}
