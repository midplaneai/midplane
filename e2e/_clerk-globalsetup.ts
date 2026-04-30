// Clerk testing-token bootstrap for the live E2E suite.
//
// clerkSetup() hits Clerk's Frontend API once at suite start, mints a
// testing token, and stuffs it into process.env.CLERK_TESTING_TOKEN so
// every later setupClerkTestingToken({ page }) call can attach it as
// __clerk_testing_token to the FAPI requests the SignIn / SignUp
// components make. Without this, Clerk's bot detection blocks
// programmatic sign-ups on the dev instance.
//
// Requires CLERK_PUBLISHABLE_KEY + CLERK_SECRET_KEY in env. Playwright
// loads .env.local in playwright.config.ts; we only need to bridge the
// NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY → CLERK_PUBLISHABLE_KEY name that
// @clerk/testing expects.
//
// Gated on E2E_LIVE=1 to match mcp-proxy.live.e2e.ts and indexer.live
// .e2e.ts — the smoke run shouldn't require Clerk creds.

import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

setup.describe.configure({ mode: "serial" });

setup.skip(
  process.env.E2E_LIVE !== "1",
  "Clerk testing-token setup only runs under E2E_LIVE=1",
);

setup("clerk testing token", async () => {
  if (!process.env.CLERK_PUBLISHABLE_KEY) {
    process.env.CLERK_PUBLISHABLE_KEY =
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  }
  if (!process.env.CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    throw new Error(
      "CLERK_PUBLISHABLE_KEY (or NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) and CLERK_SECRET_KEY must be set for live signup E2E",
    );
  }
  await clerkSetup();
});
