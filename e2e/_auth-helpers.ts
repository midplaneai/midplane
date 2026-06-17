// Better Auth E2E helpers: create a real user + browser session, read the org
// the onboarding flow creates, tear it down. Used by the live signup /
// tokens-ux suites.
//
// Approach: POST the Better Auth sign-up endpoint via page.request — which
// shares the browser context's cookie jar, so the session cookie it sets makes
// the page authed. No UI bot-detection token to mint (unlike Clerk), so there's
// no global-setup step. The org + customer row are created by the real
// /signup/region Server Action the suites drive next (Better Auth doesn't
// auto-create an org on signup); activeOrgId() reads the resulting org id off
// the session.
//
// No external service: users/orgs live in the regional Postgres (Better Auth is
// region-resident). cleanup() deletes the user + org rows directly; FK cascades
// take their session / account / member rows.

import type { Page } from "@playwright/test";
import { eq } from "drizzle-orm";

import { getDb } from "@midplane-cloud/db";
import { organization, user } from "@midplane-cloud/db/auth-schema";

function testRegion(): "eu" | "us" {
  return process.env.MIDPLANE_REGION === "us" ? "us" : "eu";
}

// Unique email per run. emailAndPassword has no verification gate, so sign-up
// immediately establishes a session.
export function freshTestEmail(): string {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `midplane-e2e-${tag}@example.com`;
}

function freshPassword(): string {
  return `Pw-${Math.random().toString(36).slice(2)}${Date.now()}`;
}

interface SessionShape {
  user?: { id?: string; email?: string };
  session?: { activeOrganizationId?: string | null };
}

async function getSession(page: Page): Promise<SessionShape | null> {
  const res = await page.request.get("/api/auth/get-session");
  if (!res.ok()) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text) as SessionShape;
}

// Create a Better Auth user and establish a browser session. No org yet — the
// /signup/region Server Action the suite drives next creates it. onUserCreated
// fires the instant the id is known so afterAll can still delete the user if a
// later step throws.
export async function signUp(
  page: Page,
  email: string,
  onUserCreated?: (userId: string) => void,
): Promise<{ userId: string }> {
  const res = await page.request.post("/api/auth/sign-up/email", {
    data: {
      name: `E2E ${email.split("@")[0]}`,
      email,
      password: freshPassword(),
    },
  });
  if (!res.ok()) {
    throw new Error(
      `Better Auth sign-up failed (${res.status()}): ${await res.text()}`,
    );
  }
  const userId = (await getSession(page))?.user?.id;
  if (!userId) {
    throw new Error("sign-up did not establish a session");
  }
  onUserCreated?.(userId);
  return { userId };
}

// The active org id on the current session — set by the /signup/region Server
// Action once onboarding completes. Call after waiting for /dashboard.
export async function activeOrgId(page: Page): Promise<string> {
  const orgId = (await getSession(page))?.session?.activeOrganizationId;
  if (!orgId) {
    throw new Error("no active organization on the session after onboarding");
  }
  return orgId;
}

// Drive onboarding to completion: accept the prefilled workspace name + submit.
// Creates the org + customer and lands on /dashboard. Returns the active org id.
//
// For an authed user the region is FIXED to this app (region-resident auth) —
// the picker shows it read-only, no choice to make — so we just submit.
export async function onboard(page: Page): Promise<{ orgId: string }> {
  await page.goto("/signup/region");
  await page.getByRole("button", { name: /continue/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 15_000 });
  return { orgId: await activeOrgId(page) };
}

// Best-effort delete of the auth rows (user + org). FK cascades remove the
// session / account / member rows. The customer / connection / audit rows are
// the suite's own cleanup. Failures here don't fail the test.
export async function cleanup(opts: {
  userId?: string;
  orgId?: string;
}): Promise<void> {
  const db = getDb(testRegion());
  try {
    if (opts.orgId) {
      await db.delete(organization).where(eq(organization.id, opts.orgId));
    }
    if (opts.userId) {
      await db.delete(user).where(eq(user.id, opts.userId));
    }
  } catch (e) {
    console.warn("[e2e auth cleanup] failed:", e);
  }
}
