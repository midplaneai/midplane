import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  reactStrictMode: true,
  // Standalone bundle for the Fly Docker deploy (fly-web.toml).
  output: "standalone",
  // Trace deps from the monorepo root so workspace packages
  // (@midplane-cloud/db, /kms, /router) ship inside the standalone output.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Drizzle + postgres-js pull pg-native via optional deps; mark them external
  // so Next's bundler doesn't try to resolve them in the edge runtime.
  serverExternalPackages: ["postgres", "drizzle-orm"],
  // Security headers applied to every route (landing, Clerk auth flows, the
  // authenticated dashboard, and API routes all share this origin).
  //
  // Scope note: this is anti-framing + cheap hardening only. We deliberately
  // do NOT set a `script-src`/`style-src` CSP here — Clerk, PostHog, Stripe,
  // and Google Fonts all load on this origin, so a strict CSP needs its own
  // nonce/allowlist pass or it white-screens the app. `frame-ancestors 'none'`
  // (plus X-Frame-Options for older UAs) closes clickjacking without that risk.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'",
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
