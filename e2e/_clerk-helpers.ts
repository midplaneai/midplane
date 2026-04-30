// Clerk E2E helpers: create a real testing user, establish a real session,
// tear it down. Used by signup.live.e2e.ts.
//
// Approach: create the user via the Clerk Backend API (an actual user row
// in the dev Clerk instance), then call @clerk/testing/playwright's
// clerk.signIn() to establish a real session in the browser. This is the
// "Method A: Server-side (Recommended)" pattern from Clerk's docs — it
// bypasses the email-verification UI but produces a fully real session
// (real cookies, real auth() userId in Server Actions). The Server Action
// boundary the test exercises is identical to what a UI-driven sign-up
// would produce.
//
// Test emails follow Clerk's reserved subaddress pattern:
//   <id>+clerk_test@<domain>
// On dev instances, these are auto-verified and don't count toward the
// monthly email-delivery cap. They DO occupy a Clerk user row, so cleanup()
// must run in afterAll to keep the dev instance under the user limit.

import { createClerkClient } from "@clerk/backend";
import { clerk, setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

function backend() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error("CLERK_SECRET_KEY must be set for Clerk E2E helpers");
  }
  return createClerkClient({ secretKey });
}

// Mint a fresh test email. The local part is randomized so concurrent runs
// (or repeated runs against a dirty Clerk instance) don't collide. The
// +clerk_test subaddress is what tells Clerk to skip real verification.
// Domain matches Clerk's own docs example (jane+clerk_test@example.com) —
// Clerk's validator rejects reserved TLDs like .test, so we stick with
// example.com.
export function freshTestEmail(): string {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `midplane-e2e-${tag}+clerk_test@example.com`;
}

// Create a real Clerk user, then establish a browser session as that user.
// Returns the Clerk userId so afterAll() can clean up.
//
// password is fixed-but-strong; Clerk requires a password by default on dev
// instances. The test never actually re-types it — sign-in uses a sign-in
// token, not the password.
export async function signUp(
  page: Page,
  email: string,
): Promise<{ clerkUserId: string }> {
  const client = backend();
  const password = `Pa55w0rd!${Math.random().toString(36).slice(2, 10)}`;
  const user = await client.users
    .createUser({
      emailAddress: [email],
      password,
      skipPasswordChecks: true,
    })
    .catch((e: unknown) => {
      // ClerkAPIResponseError surfaces the actionable detail in errors[].
      // Default toString() is just "Unprocessable Entity" — useless in CI.
      const detail =
        e &&
        typeof e === "object" &&
        "errors" in e &&
        Array.isArray((e as { errors: unknown }).errors)
          ? JSON.stringify((e as { errors: unknown[] }).errors)
          : String(e);
      throw new Error(
        `Clerk createUser failed for ${email}: ${detail}`,
        { cause: e },
      );
    });

  await setupClerkTestingToken({ page });
  // Clerk.js needs a page where ClerkProvider has loaded before signIn can
  // mount. Landing is public and loads ClerkProvider via the root layout.
  await page.goto("/");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: email });

  return { clerkUserId: user.id };
}

// Sign-in helper for tests that already have a user. Same session-establishment
// path as signUp — server-side sign-in token.
export async function signIn(page: Page, email: string): Promise<void> {
  await setupClerkTestingToken({ page });
  await page.goto("/");
  await clerk.loaded({ page });
  await clerk.signIn({ page, emailAddress: email });
}

// Best-effort delete. Failures here don't fail the test; the dev Clerk
// instance has a user-count cap that this protects, but a leaked test user
// is recoverable by hand.
export async function cleanup(clerkUserId: string): Promise<void> {
  try {
    await backend().users.deleteUser(clerkUserId);
  } catch (e) {
    console.warn(`[clerk cleanup] failed to delete ${clerkUserId}:`, e);
  }
}
