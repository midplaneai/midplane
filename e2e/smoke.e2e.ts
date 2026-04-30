import { expect, test } from "@playwright/test";

// PR #1 baseline: the landing page renders and the protected route bounces.
// PR #2 fills in the full sign-up → paste → /health critical path.

test("landing page renders the sign-in CTA", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Midplane" })).toBeVisible();
  await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
});

test("dashboard redirects unauthenticated visitors", async ({ page }) => {
  const res = await page.goto("/dashboard");
  // Clerk middleware bounces to its hosted sign-in flow. We don't assert the
  // exact destination URL — Clerk hosts that — only that we don't render the
  // dashboard.
  await expect(page.getByText("No connections yet")).not.toBeVisible();
  // The response itself may be a redirect or a Clerk-served page; either is
  // fine as long as we left the dashboard route.
  expect(res?.status() ?? 200).toBeLessThan(500);
});
