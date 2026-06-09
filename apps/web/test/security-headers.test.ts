// Anti-clickjacking + hardening headers must apply to every route. This
// origin serves the marketing landing, the Clerk sign-in/sign-up flows, AND
// the authenticated dashboard, so a missing frame-ancestors directive is a
// clickjacking primitive against the auth surface — not just the brochure.
//
// We assert the config-level contract (next.config.ts headers()) rather than
// spinning up Next: the values are static and the regression we care about is
// "someone deleted/loosened a header", which a unit check catches cheaply.

import { describe, expect, it } from "vitest";

import config from "../next.config.ts";

async function headerMap() {
  const rules = await config.headers!();
  // Single catch-all rule covering "/:path*".
  const all = rules.find((r) => r.source === "/:path*");
  expect(all, "expected a catch-all /:path* header rule").toBeDefined();
  return new Map(all!.headers.map((h) => [h.key, h.value]));
}

describe("security headers", () => {
  it("blocks framing on every route (clickjacking)", async () => {
    const h = await headerMap();
    expect(h.get("X-Frame-Options")).toBe("DENY");
    // CSP frame-ancestors is the modern, UA-respected control; X-Frame-Options
    // is the belt-and-suspenders for older browsers. Both must say no-frame.
    expect(h.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("sets the cheap hardening headers", async () => {
    const h = await headerMap();
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("Permissions-Policy")).toBeTruthy();
    // HSTS with a non-trivial max-age (Fly force_https only redirects; the
    // header is what pins future visits to TLS).
    expect(h.get("Strict-Transport-Security")).toMatch(
      /max-age=\d{7,}/,
    );
  });
});
