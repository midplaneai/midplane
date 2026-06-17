import { FlatCompat } from "@eslint/eslintrc";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    // Open-core boundary (the flip): MIT core must NEVER import from ee/
    // (commercial, license-key gated). ee/ MAY import core, never the reverse,
    // so deleting ee/ always leaves a working MIT build. CI-enforced from day
    // one, even while ee/ is nearly empty. Uses the base no-restricted-imports
    // rule (ESLint core — always resolves, no plugin-namespace dependency); it
    // catches runtime core->ee imports, the licensing/bundle invariant. (Type-
    // only imports aren't caught here; upgrade to the typescript-eslint variant
    // if core ever type-depends on ee/.) See open-core design doc + manifest.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/ee/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/ee", "@/ee/**", "**/ee", "**/ee/**"],
              message:
                "Open-core boundary: MIT core must not import from ee/ (commercial, license-key gated). ee/ may import core, never the reverse.",
            },
          ],
        },
      ],
    },
  },
];

export default config;
