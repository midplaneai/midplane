// Plain-ESM config (.mjs, not .ts): Next 16's TypeScript-config loader
// transpiles next.config.ts to CommonJS and evaluates it through a hook that
// breaks under this package's `"type": "module"` — on Node ("exports is not
// defined in ES module scope") and differently under Bun. An .mjs config
// skips that loader entirely and works on both runtimes; the JSDoc @type
// keeps editor/typecheck support.
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Standalone bundle for the Fly Docker deploy (fly-web.toml).
  output: "standalone",
  // Trace deps from the monorepo root so workspace packages
  // (@midplane-cloud/db, /kms, /router) ship inside the standalone output.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Drizzle + postgres-js pull pg-native via optional deps; mark them external
  // so Next's bundler doesn't try to resolve them in the edge runtime.
  serverExternalPackages: ["postgres", "drizzle-orm"],
  // Security headers applied to every route (landing, auth flows, the
  // authenticated dashboard, and API routes all share this origin).
  //
  // Scope note: still no `script-src`/`style-src` here, but the reason has
  // changed and is worth stating precisely, because the old one is no longer
  // true. This used to read "Clerk, PostHog, Stripe, and Google Fonts all load
  // on this origin, so a strict CSP needs a nonce/allowlist pass". None of that
  // holds now: auth is Better Auth (no Clerk), PostHog is server-side only (no
  // posthog-js in the bundle), Stripe is hosted Checkout reached by REDIRECT
  // (no embedded js.stripe.com), and next/font/google self-hosts the font files
  // at build time (no fonts.googleapis.com).
  //
  // The one third-party script the browser does load is Cloudflare Turnstile
  // (challenges.cloudflare.com) on the sign-up form, and only when the
  // Turnstile env is set — so a `script-src` allowlist is one known origin, not
  // an open-ended audit.
  //
  // What actually blocks `script-src` now is Next's own inline hydration
  // bootstrap, which needs either 'unsafe-inline' (worthless) or a per-request
  // nonce plumbed through middleware.ts. That's tractable and worth doing — see
  // the note in test/security-headers.test.ts — but it touches the region
  // routing middleware, so it's a deliberate follow-up rather than a drive-by.
  // Turnstile also needs frame-src for its challenge iframe, so that pass
  // should land both directives together.
  //
  // The directives below are the subset that needs no nonce and cannot break a
  // page that loads no plugins and sets no <base>:
  //   - object-src 'none' kills <object>/<embed> plugin-based script execution.
  //   - base-uri 'self' blocks an injected <base href> from silently
  //     repointing every relative URL (script, form, link) at another origin.
  //   - frame-ancestors 'none' (+ X-Frame-Options for older UAs) is the
  //     clickjacking control.
  // `form-action` is deliberately absent: MCP OAuth redirects out to external
  // client callbacks (VS Code loopback, agent clients), and some browsers apply
  // form-action across post-submission redirects — that would break the OAuth
  // flow, so it needs testing rather than assumption.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default config;
