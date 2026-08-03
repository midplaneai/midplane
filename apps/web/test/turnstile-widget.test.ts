// Regression guards for two ways the Turnstile widget could strand a user on a
// permanently disabled signup button.
//
// Both are source-level assertions: the widget talks to Cloudflare's injected
// global and needs a real DOM + network to exercise, and the failures are
// structural (a missing wire-up), not branch logic we can drive with inputs.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(rel: string): Promise<string> {
  return readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

const SIGNUP_SURFACES = [
  "../src/components/auth/sign-up-form.tsx",
  "../src/app/accept-invitation/[id]/accept-invite.tsx",
];

describe("spent tokens can be replaced", () => {
  it("the widget re-renders when resetSignal changes", async () => {
    // Turnstile tokens are single-use. resetSignal must be a dependency of the
    // render effect, or bumping it does nothing and the stale widget stays.
    const code = await source("../src/components/auth/turnstile-widget.tsx");
    expect(code).toMatch(/\[siteKey,\s*action,\s*resetSignal\]/);
  });

  it.each(SIGNUP_SURFACES)("%s resets the widget after a failed submit", async (file) => {
    // Clearing our copy of the token is NOT enough: the widget keeps showing a
    // solved challenge whose token is spent, so the submit button never
    // re-enables and the user has no way to retry.
    const code = await source(file);
    expect(code).toMatch(/setCaptchaToken\(null\)/);
    expect(code).toMatch(/setCaptchaReset\(\(n\)\s*=>\s*n\s*\+\s*1\)/);
  });
});

describe("retry after a failed script load actually retries", () => {
  it("drops the cached promise AND the dead <script> on failure", async () => {
    // The subtle one. Re-listening to a <script> whose load/error already fired
    // waits for events that never come again, so the promise never settles and
    // "Try again" hangs silently — worse than the disabled button it replaced.
    // Recovery requires discarding BOTH the memoized promise and the dead tag.
    const code = await source("../src/components/auth/turnstile-widget.tsx");
    expect(code).toMatch(/loadPromise\s*=\s*null/);
    expect(code).toMatch(/getElementById\(SCRIPT_ID\)\?\.remove\(\)/);
  });

  it("never re-attaches listeners to an existing script element", async () => {
    // This is the shape of the bug: find-by-id, then addEventListener on it.
    const code = await source("../src/components/auth/turnstile-widget.tsx");
    expect(code).not.toMatch(/existing\.addEventListener/);
  });
});

describe("a failed script load is explained, not silent", () => {
  it("the widget reports load failure on its own channel", async () => {
    // onToken(null) means "not solved yet". Collapsing a load failure into it
    // makes the two indistinguishable, so the form disables submit forever and
    // says nothing.
    const code = await source("../src/components/auth/turnstile-widget.tsx");
    expect(code).toMatch(/onLoadError/);
    expect(code).toMatch(/onLoadErrorRef\.current\?\.\(\)/);
  });

  it.each(SIGNUP_SURFACES)("%s surfaces the failure with a retry", async (file) => {
    const code = await source(file);
    expect(code).toMatch(/onLoadError=\{/);
    expect(code).toMatch(/captchaFailed/);
    // The message must be reachable by assistive tech, not just visible.
    expect(code).toMatch(/role="alert"/);
    expect(code).toMatch(/Try again/);
  });
});
