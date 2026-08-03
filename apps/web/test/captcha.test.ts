// Turnstile bot protection on signup (lib/captcha.ts). Same env-gate posture as
// isEmailConfigured: cloud-only, all-or-nothing, never on in self-host.
//
// Prompted by an automated signup that planted a stored-XSS probe in
// `user.name`. Per-IP rate limiting would not have caught it — one signup, one
// address — so the control has to score the client, not the rate.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captchaAllowedHostnames,
  captchaSiteKey,
  isCaptchaConfigured,
} from "../src/lib/captcha.ts";

const SITE = "TURNSTILE_SITE_KEY";
const SECRET = "TURNSTILE_SECRET_KEY";

describe("isCaptchaConfigured", () => {
  const prevSelfHost = process.env.MIDPLANE_SELF_HOST;

  beforeEach(() => {
    delete process.env.MIDPLANE_SELF_HOST;
  });

  afterEach(() => {
    if (prevSelfHost === undefined) delete process.env.MIDPLANE_SELF_HOST;
    else process.env.MIDPLANE_SELF_HOST = prevSelfHost;
  });

  it("is true in cloud with both Turnstile vars set", () => {
    expect(
      isCaptchaConfigured({ [SITE]: "1x0000", [SECRET]: "1x0000secret" }),
    ).toBe(true);
  });

  it("is false when only one var is set — half-configured must fail OPEN", () => {
    // The dangerous direction: secret-only would make the server demand a token
    // that the un-rendered widget never mints, so every signup would fail
    // closed. Treating half-configuration as "off" is the safe reading.
    expect(isCaptchaConfigured({ [SECRET]: "1x0000secret" })).toBe(false);
    expect(isCaptchaConfigured({ [SITE]: "1x0000" })).toBe(false);
    expect(isCaptchaConfigured({})).toBe(false);
  });

  it("is always false in self-host, even with both vars set", () => {
    // Accepting the first user must never require a Cloudflare account.
    process.env.MIDPLANE_SELF_HOST = "1";
    expect(
      isCaptchaConfigured({ [SITE]: "1x0000", [SECRET]: "1x0000secret" }),
    ).toBe(false);
  });
});

describe("captchaSiteKey", () => {
  const prevSelfHost = process.env.MIDPLANE_SELF_HOST;

  beforeEach(() => {
    delete process.env.MIDPLANE_SELF_HOST;
  });

  afterEach(() => {
    if (prevSelfHost === undefined) delete process.env.MIDPLANE_SELF_HOST;
    else process.env.MIDPLANE_SELF_HOST = prevSelfHost;
  });

  it("returns the key when fully configured", () => {
    expect(
      captchaSiteKey({ [SITE]: "1x0000", [SECRET]: "1x0000secret" }),
    ).toBe("1x0000");
  });

  it("returns null whenever the server is not enforcing", () => {
    // The two gates MUST agree. If the widget could render while the plugin is
    // off, users would solve a pointless challenge; if the plugin could enforce
    // while the widget is absent, every signup would fail closed with an opaque
    // error. Deriving both from isCaptchaConfigured() makes disagreement
    // unrepresentable.
    expect(captchaSiteKey({ [SITE]: "1x0000" })).toBeNull();
    expect(captchaSiteKey({ [SECRET]: "1x0000secret" })).toBeNull();
    expect(captchaSiteKey({})).toBeNull();

    process.env.MIDPLANE_SELF_HOST = "1";
    expect(
      captchaSiteKey({ [SITE]: "1x0000", [SECRET]: "1x0000secret" }),
    ).toBeNull();
  });

  it("is not read from a NEXT_PUBLIC_ variable", () => {
    // Regression guard for a build-vs-runtime trap: NEXT_PUBLIC_* is inlined
    // into the client bundle at BUILD time, and apps/web/Dockerfile passes no
    // build args for it. A NEXT_PUBLIC_ site key set as a runtime Fly secret
    // would therefore be visible to the server (plugin enabled, token demanded)
    // and undefined in the browser (widget absent, no token) — 100% signup
    // failure that the all-or-nothing check above cannot detect, because the
    // two halves disagree about the same variable.
    expect(
      captchaSiteKey({
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x0000",
        [SECRET]: "1x0000secret",
      }),
    ).toBeNull();
  });
});

describe("captchaAllowedHostnames", () => {
  it("covers the apex AND both regional dashboards", () => {
    // One image answers on several hosts. An allowlist built from only
    // BETTER_AUTH_URL would reject legitimate signups on whichever host isn't
    // that one — the same multi-host trap that broke sign-in with
    // "Invalid origin" before trustedAuthOrigins() existed.
    const hosts = captchaAllowedHostnames({
      BETTER_AUTH_URL: "https://eu.app.midplane.ai",
    });
    expect(hosts).toContain("app.midplane.ai");
    expect(hosts).toContain("eu.app.midplane.ai");
    expect(hosts).toContain("us.app.midplane.ai");
  });

  it("includes the BETTER_AUTH_URL host so localhost dev works unconfigured", () => {
    const hosts = captchaAllowedHostnames({
      BETTER_AUTH_URL: "http://localhost:3000",
    });
    expect(hosts).toContain("localhost");
    // Bare hostname, never host:port — Turnstile reports no port.
    expect(hosts.every((h) => !h.includes(":"))).toBe(true);
  });

  it("tolerates a malformed BETTER_AUTH_URL without throwing", () => {
    // assertBootEnv is the place that validates it; this must not be a second
    // failure point during plugin construction.
    expect(() => captchaAllowedHostnames({ BETTER_AUTH_URL: "not a url" })).not.toThrow();
    expect(captchaAllowedHostnames({})).toContain("app.midplane.ai");
  });
});
