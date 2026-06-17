// Live UX E2E for the token-management surface (PR3 of
// mcp_url_auth_security). Drives the dashboard pages a real customer
// sees: create connection → success page renders the URL → connection
// detail page lists the default token → open the create-token modal
// → fill the form → see the show-once URL → close modal → list shows
// the new row → revoke the original token → list shows Revoked.
//
// Does NOT exercise the MCP runtime (that's mcp-proxy.live.e2e.ts and
// tokens.live.e2e.ts). Does NOT need Docker — the only Server Action
// that touches the regional DB is createConnection, which encrypts a
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
  connections,
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
let connectionId = "";

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
        .from(connections)
        .where(eq(connections.customerId, customerId));
      for (const c of conns) {
        await db
          .delete(indexerCursors)
          .where(eq(indexerCursors.connectionId, c.id));
      }
      await db
        .delete(connections)
        .where(eq(connections.customerId, customerId));
      await db
        .delete(auditEventsIndex)
        .where(eq(auditEventsIndex.customerId, customerId));
      await db.delete(customers).where(eq(customers.id, customerId));
    }
  }
  await cleanup({ userId, orgId });
});

test("create connection → mint second token → revoke default → list reflects state", async ({
  page,
}) => {
  testEmail = freshTestEmail();
  await signUp(page, testEmail, (id) => {
    userId = id;
  });

  // Onboard: the region picker creates the org + customer (Better Auth doesn't
  // auto-create one) and lands on /dashboard.
  ({ orgId } = await onboard(page));

  // A throwaway DSN; we never dial it. createConnection encrypts at
  // rest and auto-mints the default token — that's the only behavior
  // this test exercises before navigating to the UX surface.
  await page.goto("/connections/new");
  await page.getByLabel(/name/i).fill("e2e-ux");
  await page
    .getByLabel(/database_url/i)
    .fill("postgres://user:pass@nowhere.local:5432/db?sslmode=disable");
  await page.getByRole("button", { name: /create connection/i }).click();
  await page.waitForURL(/\/connections\/[A-Z0-9]+\/created/i, {
    timeout: 15_000,
  });

  const urlPath = new URL(page.url()).pathname;
  const match = /\/connections\/([0-9A-HJKMNP-TV-Z]{26})\/created/i.exec(
    urlPath,
  );
  if (!match?.[1]) throw new Error(`could not parse conn id from ${urlPath}`);
  connectionId = match[1];

  // Success page shows the default token URL exactly once. Format gate
  // matches the lib's prefix + 32 hex + 6-char checksum.
  const defaultUrl = await page
    .getByTestId("show-once-url")
    .first()
    .inputValue();
  expect(defaultUrl).toMatch(
    /^https?:\/\/.+\/mcp\/mp_(live|test)_[0-9a-f]{32}_[0-9A-HJKMNP-Z]{6}$/,
  );

  // Navigate to the connection detail page. The "I've saved it" button is
  // gated by a short countdown (it stays disabled for a few seconds);
  // Playwright's click auto-waits for it to become enabled. The default
  // token (named "default" by createConnection) must appear in the list.
  await page.getByTestId("saved-it").click();
  await page.waitForURL(`**/connections/${connectionId}`, { timeout: 10_000 });
  // The connection page defaults to the Database section; tokens live under the
  // Agents section. Go there directly.
  await page.goto(`/connections/${connectionId}?section=agents`);
  const list = page.getByTestId("token-list");
  await expect(list).toBeVisible();
  const defaultRow = list.locator('[data-testid="token-row"]', {
    hasText: "default",
  });
  await expect(defaultRow).toBeVisible();
  // data-status is on the token-row <li> itself, not a descendant.
  await expect(defaultRow).toHaveAttribute(
    "data-status",
    /active|expiring|stale/,
  );

  // Open the connect-an-agent modal, fill it, submit. The show-once URL
  // surface should replace the form. Anchor the trigger name so it
  // doesn't also match the "how to connect an agent" disclosure summary
  // rendered on the same (populated) page.
  await page.getByRole("button", { name: /^connect an agent$/i }).click();
  await page.getByLabel(/name/i).fill("ci-bot");
  await page.getByLabel(/expiry/i).selectOption("30");
  await page.getByRole("button", { name: /^connect agent$/i }).click();

  const modalUrl = await page.getByTestId("show-once-url").last().inputValue();
  expect(modalUrl).toMatch(
    /^https?:\/\/.+\/mcp\/mp_(live|test)_[0-9a-f]{32}_[0-9A-HJKMNP-Z]{6}$/,
  );
  // Two different tokens — the modal shouldn't echo the default token.
  expect(modalUrl).not.toBe(defaultUrl);

  await page.getByTestId("ive-saved-it").click();

  // Both tokens now visible.
  await expect(
    list.locator('[data-testid="token-row"]', { hasText: "ci-bot" }),
  ).toBeVisible();
  await expect(defaultRow).toBeVisible();

  // Revoke the default token. Confirm dialog opens, click Revoke, the
  // row's status should flip to Revoked on the refreshed list.
  await defaultRow.getByTestId("revoke-token").click();
  await page.getByRole("alertdialog").getByRole("button", { name: /^revoke$/i }).click();

  // Wait for the row to re-render with the revoked status. Server
  // Action calls revalidatePath; Next refreshes the Server Component
  // tree. The row stays in the list (history is preserved) — only the
  // badge / actions change.
  await expect(defaultRow).toHaveAttribute("data-status", "revoked", {
    timeout: 10_000,
  });
  // Revoked rows lose the per-row revoke button.
  await expect(defaultRow.getByTestId("revoke-token")).toHaveCount(0);
});

void testEmail;
