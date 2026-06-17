import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

// Tiny .env.local loader. The test process needs DATABASE_URL_EU +
// MIDPLANE_REGION=eu + MIDPLANE_KMS_DEV_KEY_EU for the live E2E's seed
// step (encryptDsn, getDb). Next.js loads .env.local for the dev server
// itself, but Playwright workers don't inherit that unless we forward
// it here.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadDotenv(resolve(__dirname, ".env.local"));

function loadDotenv(path: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const [, key, raw] = m;
    if (!key) continue;
    if (process.env[key] !== undefined) continue;
    const val = raw?.replace(/^['"]|['"]$/g, "") ?? "";
    process.env[key] = val;
  }
}

export default defineConfig({
  testDir: "./e2e",
  // .e2e.ts (not .spec.ts / .test.ts) so Bun's default unit-test discovery
  // — `bun test` — doesn't pick the suite up and choke trying to run it as
  // a Bun test.
  testMatch: /.*\.e2e\.ts$/,
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // One project. Better Auth needs no global-setup (no bot-detection token
    // to mint, unlike Clerk): the live suites establish sessions via the
    // sign-up API in-test (see _auth-helpers.ts). workers:1 keeps the
    // Docker-spawning live suites serial.
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "bun --filter '@midplane-cloud/web' dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
