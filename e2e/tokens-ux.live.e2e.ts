// Live UX E2E for the agent-management surface. Drives the dashboard pages a
// real customer sees: create project → land on the Connect tab (OAuth-first,
// so no auto-minted token) → the agent list is empty → open the create-token
// modal → fill the form → see the show-once URL → save it → list shows the new
// machine-token agent → revoke it → list shows Revoked.
//
// Does NOT exercise the MCP runtime (that's mcp-proxy.live.e2e.ts and
// tokens.live.e2e.ts). Does NOT need Docker — the only Server Action
// that touches the regional DB is createProject, which encrypts a
// throwaway DSN that never gets dialed; the token modal calls a
// Server Action that goes straight to the lib.
//
// Gated on:
//   - E2E_LIVE=1
//   - .env.local DATABASE_URL_<REGION> pointing at a Neon dev branch
//   - .env.local MIDPLANE_TOKEN_PEPPER_<REGION>_V1 set
//   - .env.local BETTER_AUTH_SECRET + MIDPLANE_REGION_COOKIE_SECRET

import { expect, test } from "@playwright/test";
import { eq } from "drizzle-orm";

import {
  auditEventsIndex,
  projects,
  customers,
  getDb,
  indexerCursors,
} from "@midplane-cloud/db";

import { cleanup, freshTestEmail, onboard, signUp } from "./_auth-helpers";

test.skip(
  process.env.E2E_LIVE !== "1",
  "set E2E_LIVE=1 to run live tokens-ux E2E (requires Neon + the auth secrets)",
);

let testEmail = "";
let userId = "";
let orgId = "";
let projectId = "";

test.afterAll(async () => {
  if (orgId) {
    const db = getDb("eu");
    const customerRows = await db
      .select()
      .from(customers)
      .where(eq(customers.orgId, orgId));
    const customerId = customerRows[0]?.id;
    if (customerId) {
      const conns = await db
        .select()
        .from(projects)
        .where(eq(projects.customerId, customerId));
      for (const c of conns) {
        await db
          .delete(indexerCursors)
          .where(eq(indexerCursors.projectId, c.id));
      }
      await db
        .delete(projects)
        .where(eq(projects.customerId, customerId));
      await db
        .delete(auditEventsIndex)
        .where(eq(auditEventsIndex.customerId, customerId));
      await db.delete(customers).where(eq(customers.id, customerId));
    }
  }
  await cleanup({ userId, orgId });
});

test("create project → mint machine token → revoke → list reflects state", async ({
  page,
}) => {
  testEmail = freshTestEmail();
  await signUp(page, testEmail, (id) => {
    userId = id;
  });

  // Onboard: the region picker creates the org + customer (Better Auth doesn't
  // auto-create one) and lands on /dashboard.
  ({ orgId } = await onboard(page));

  // A throwaway DSN; we never dial it. createProject encrypts at rest. The web
  // flow is OAuth-first, so NO token is auto-minted — the create lands on the
  // Connect tab with an empty agent list.
  await page.goto("/projects/new");
  await page.getByLabel(/name/i).fill("e2e-ux");
  await page
    .getByLabel(/database_url/i)
    .fill("postgres://user:pass@nowhere.local:5432/db?sslmode=disable");
  await page.getByRole("button", { name: /^connect$/i }).click();
  await page.waitForURL(/\/projects\/[0-9A-HJKMNP-TV-Z]{26}(\?|$)/i, {
    timeout: 15_000,
  });

  const urlPath = new URL(page.url()).pathname;
  const match = /\/projects\/([0-9A-HJKMNP-TV-Z]{26})/i.exec(urlPath);
  if (!match?.[1]) throw new Error(`could not parse conn id from ${urlPath}`);
  projectId = match[1];

  // On the Connect tab the agent list starts empty — no auto-minted token.
  await page.goto(`/projects/${projectId}?section=connect`);
  const list = page.getByTestId("agent-list");
  await expect(list).toBeVisible();
  await expect(list).toHaveAttribute("data-state", "empty");

  // Open the create-token modal, fill it, submit. The show-once URL surface
  // replaces the form. The project's single DB defaults to read scope, so the
  // form submits as-is.
  await page.getByRole("button", { name: /^create machine token$/i }).click();
  await page.getByLabel(/name/i).fill("ci-bot");
  await page.getByLabel(/expiry/i).selectOption("30");
  await page.getByRole("button", { name: /^connect agent$/i }).click();

  const modalUrl = await page.getByTestId("show-once-url").last().inputValue();
  expect(modalUrl).toMatch(
    /^https?:\/\/.+\/mcp\/mp_(live|test)_[0-9a-f]{32}_[0-9A-HJKMNP-Z]{6}$/,
  );

  await page.getByTestId("ive-saved-it").click();

  // The new machine-token agent now shows in the list.
  const botRow = list.locator('[data-testid="agent-row"]', {
    hasText: "ci-bot",
  });
  await expect(botRow).toBeVisible();
  await expect(botRow).toHaveAttribute("data-status", /active|expiring|stale/);
  await expect(botRow).toHaveAttribute("data-agent-kind", "url");

  // Revoke it. Confirm dialog opens, click Revoke, the row's status flips to
  // Revoked on the refreshed list (revalidatePath re-renders the tree).
  await botRow.getByTestId("revoke-token").click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^revoke$/i })
    .click();

  await expect(botRow).toHaveAttribute("data-status", "revoked", {
    timeout: 10_000,
  });
  // Revoked rows lose the per-row revoke button.
  await expect(botRow.getByTestId("revoke-token")).toHaveCount(0);
});

void testEmail;
