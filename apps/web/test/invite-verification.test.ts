// Regression guard: the signup path must never mark an address verified.
//
// A prior version pre-verified any signup that had a pending invitation for the
// same address, reasoning that holding an invite proved mailbox control. It does
// not. Signup asserts an email and carries no invitation id or token, so merely
// KNOWING that an address had been invited was enough to register it with an
// attacker-chosen password. And because acceptInvitation validates the
// invitation against the SESSION's email, that forged account then satisfied the
// check and could join the org — the exemption switched off email verification
// exactly on the path that grants tenant access.
//
// This is a source-level assertion (same posture as health.test.ts asserting the
// health route imports no db client) because the failure mode is someone
// re-adding the shortcut to smooth out the invite flow, not a runtime branch we
// can exercise without a live Better Auth instance + database.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

async function source(rel: string): Promise<string> {
  return readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** Strip line and block comments so prose ABOUT emailVerified (including the
 *  warning this test exists to enforce) doesn't read as a write to it. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("signup never self-certifies an email address", () => {
  it("lib/auth.ts contains no write to emailVerified", async () => {
    const code = stripComments(await source("../src/lib/auth.ts"));
    // Any of `emailVerified: true`, `emailVerified = true`, or a shorthand
    // include in a patch object would re-open the bypass.
    expect(code).not.toMatch(/emailVerified\s*[:=]/);
  });

  it("the pending-invitation exemption module is gone", async () => {
    await expect(source("../src/lib/invited-signup.ts")).rejects.toThrow();
  });

  it("no module reintroduces a pending-invitation lookup for verification", async () => {
    const code = stripComments(await source("../src/lib/auth.ts"));
    expect(code).not.toMatch(/hasPendingInvitation/);
  });
});

describe("invite signup routes verification back to the invitation", () => {
  it("passes the invitation page as the post-verification callbackURL", async () => {
    // Without this the invited user verifies, lands on a generic page, and the
    // invitation is left pending with no obvious way back to it.
    const code = await source(
      "../src/app/accept-invitation/[id]/accept-invite.tsx",
    );
    expect(code).toMatch(/callbackURL:\s*`\/accept-invitation\/\$\{invitationId\}`/);
  });

  it("handles the no-session result instead of accepting blindly", async () => {
    // signUp.email returns token: null when verification is required. Calling
    // accept() there would fail on a missing session.
    const code = await source(
      "../src/app/accept-invitation/[id]/accept-invite.tsx",
    );
    expect(code).toMatch(/data\?\.token/);
    expect(code).toMatch(/setAwaitingVerification\(true\)/);
  });
});
