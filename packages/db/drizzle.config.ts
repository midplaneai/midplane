import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "drizzle-kit";

// drizzle-kit auto-loads .env from cwd, which under bun --filter is
// packages/db — but the repo's .env.local lives at the workspace root.
// Walk up and seed process.env so DATABASE_URL resolves the same way the
// migrate script (--env-file=../../.env.local) sees it. drizzle-kit
// transpiles this file to CJS before evaluating it, so we can't use
// import.meta — walk up from cwd instead.
function findEnvFileUp(start: string, name: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const rootEnv = findEnvFileUp(process.cwd(), ".env.local");
if (rootEnv) {
  for (const line of readFileSync(rootEnv, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && m[1] && process.env[m[1]] === undefined) {
      process.env[m[1]] = (m[2] ?? "").replace(/^["'](.*)["']$/, "$1");
    }
  }
}

// drizzle-kit only ever needs ONE DB to introspect schema for `generate`.
// Prefer EU (the historical default); fall back to US for the rare laptop
// where only the US branch is configured.
const introspectionUrl =
  process.env.DATABASE_URL_EU ?? process.env.DATABASE_URL_US ?? "";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: introspectionUrl,
  },
  strict: true,
  verbose: true,
});
