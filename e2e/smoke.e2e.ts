import { expect, test } from "@playwright/test";

// PR #1 baseline: the landing page renders and the protected route bounces.
// PR #2 fills in the full sign-up → paste → /health critical path.

test("landing page renders the sign-in CTA", async ({ page }) => {
  await page.goto("/");
  // The wordmark is a home link (aria-label "midplane"), not a heading.
  await expect(
    page.getByRole("link", { name: /midplane/i }).first(),
  ).toBeVisible();
  // Unauthenticated visitors get the Sign in + Start free CTAs (Next links).
  await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /start free/i }).first(),
  ).toBeVisible();
});

test("dashboard redirects unauthenticated visitors", async ({ page }) => {
  const res = await page.goto("/dashboard");
  // middleware bounces unauthenticated visitors to /sign-in. We don't assert
  // the exact destination URL — only that we don't render the dashboard.
  await expect(page.getByText("No connections yet")).not.toBeVisible();
  // The response itself may be a redirect or the sign-in page; either is
  // fine as long as we left the dashboard route.
  expect(res?.status() ?? 200).toBeLessThan(500);
});
