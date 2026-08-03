import { captcha } from "better-auth/plugins";

import { isSelfHost } from "./self-host.ts";
import { APEX_HOST, REGION_HOST } from "./region-routing.ts";

// Bot protection on signup, via Cloudflare Turnstile and Better Auth's captcha
// plugin.
//
// Why: an automated signup planted a stored-XSS probe in `user.name` from a
// datacenter IP with a scripted-Chrome UA. Note that per-IP rate limiting would
// NOT have caught that — it was a single signup from a single address, so there
// was no rate to limit. What distinguishes it is the client, which is exactly
// what Turnstile scores.
//
// Scope: `/sign-up/email` ONLY, not the plugin's default trio. Deliberate.
// Putting a challenge on `/sign-in/email` taxes the most-travelled path in the
// app for a threat (credential stuffing) that lib/rate-limit.ts already
// addresses. `/request-password-reset` is a genuine mail-amplification vector
// and is the next one worth adding — it needs the widget mounted on BOTH reset
// entry points (the /forgot page and the inline "forgot password" step inside
// sign-in-flow.tsx), which is why it isn't in this pass.
//
// Configured ONLY in the CLOUD build with BOTH keys present, mirroring
// isEmailConfigured(). Requiring both is not pedantry: with only the secret set,
// the server would demand a token the un-rendered widget never mints, and every
// signup would fail closed. Self-host must never require a Cloudflare account to
// accept its first user, so it's always off there.
//
// NOTE ON THE SITE KEY NAME — it is deliberately NOT `NEXT_PUBLIC_`.
// The site key is public and a NEXT_PUBLIC_ prefix looks like the obvious
// choice, but it would silently break production here. NEXT_PUBLIC_* is INLINED
// AT BUILD TIME into the client bundle, and apps/web/Dockerfile passes no
// build args for it (by design — every other secret in this app is a runtime
// Fly secret). So a NEXT_PUBLIC_ site key set via `fly secrets` would be:
//   - visible to the SERVER at runtime  → isCaptchaConfigured() true → plugin
//     enabled → every /sign-up/email demands an x-captcha-response header;
//   - `undefined` in the CLIENT bundle  → the widget never renders → no token.
// i.e. 100% signup failure, and the all-or-nothing check above cannot catch it
// because the two halves genuinely disagree about the same variable.
//
// Reading it server-side and passing it down as a prop keeps ONE runtime source
// of truth that both halves resolve from, makes rotation a `fly secrets set` +
// restart instead of an image rebuild, and preserves the Dockerfile's
// "no NEXT_PUBLIC_* build args" property.

/** The Turnstile action name. Must match the `action` the widget is rendered
 *  with (components/auth/turnstile-widget.tsx) or verification rejects the
 *  token — that binding is what stops a token minted on some other surface from
 *  being replayed against signup. */
export const CAPTCHA_ACTION = "signup";

type EnvLike = Record<string, string | undefined>;

/** True when this process can challenge signups: the CLOUD build with both the
 *  server secret and the site key. Self-host is always false. */
export function isCaptchaConfigured(env: EnvLike = process.env): boolean {
  if (isSelfHost()) return false;
  return Boolean(env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY);
}

/** The site key to render the widget with, or null when captcha is off. Call
 *  this from a SERVER component and pass the result down as a prop — see the
 *  NEXT_PUBLIC_ note above for why the client must not read env directly.
 *
 *  Gated on the full isCaptchaConfigured() check, not just the key's presence,
 *  so a half-configured deploy renders no widget instead of an unsolvable one
 *  (and the server correspondingly isn't enforcing). */
export function captchaSiteKey(env: EnvLike = process.env): string | null {
  if (!isCaptchaConfigured(env)) return null;
  return env.TURNSTILE_SITE_KEY ?? null;
}

/** Hostnames a Turnstile token may have been issued for. One image answers on
 *  several hosts — the apex plus each regional dashboard — so an allowlist
 *  built from only BETTER_AUTH_URL would reject legitimate signups on whichever
 *  host isn't that one (the same multi-host trap trustedAuthOrigins() exists to
 *  avoid). BETTER_AUTH_URL's own host is included so localhost dev and
 *  self-host-style single-host deploys work without extra config. */
export function captchaAllowedHostnames(env: EnvLike = process.env): string[] {
  const hosts = new Set<string>([APEX_HOST, ...Object.values(REGION_HOST)]);
  const base = env.BETTER_AUTH_URL;
  if (base) {
    try {
      hosts.add(new URL(base).hostname);
    } catch {
      // assertBootEnv already validates BETTER_AUTH_URL; a malformed value
      // surfaces there, not here.
    }
  }
  // Strip any port that leaked in from a host constant — Turnstile reports a
  // bare hostname.
  return [...hosts].map((h) => h.split(":")[0]!).filter(Boolean);
}

/** The captcha plugin, or [] when unconfigured. Spread into the plugins array
 *  the same way buildStripePlugins() is. */
export function buildCaptchaPlugins() {
  if (!isCaptchaConfigured()) return [];
  return [
    captcha({
      provider: "cloudflare-turnstile",
      secretKey: process.env.TURNSTILE_SECRET_KEY as string,
      endpoints: ["/sign-up/email"],
      expectedAction: CAPTCHA_ACTION,
      allowedHostnames: captchaAllowedHostnames(),
    }),
  ];
}
