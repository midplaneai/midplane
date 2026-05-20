import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Resolve the apps/web "@/*" alias so tests that load route handlers
// (which import `@/lib/foo` per the Next.js TS path mapping) can find
// the dependency under vitest. Without this, any test importing a
// route file that pulls `@/lib/*` ESM-throws "Failed to load url" at
// collection time. Mirror the apps/web/tsconfig.json paths.
const webSrc = fileURLToPath(new URL("./apps/web/src/", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: `${webSrc}$1` },
    ],
  },
  test: {
    include: [
      "packages/**/test/**/*.test.ts",
      "apps/**/test/**/*.test.ts",
      "infra/**/test/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    environment: "node",
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**", "apps/*/src/**", "infra/*/src/**"],
    },
  },
});
