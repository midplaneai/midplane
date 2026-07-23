// eslint-config-next 16 ships native flat configs (arrays), so the FlatCompat
// bridge is gone — running the legacy shareable configs through it crashes
// with a circular-structure error under ESLint 9.
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

const config = [
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts"],
  },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // eslint-plugin-react-hooks v7 (via eslint-config-next 16) added
    // set-state-in-effect as an ERROR. The existing hits are deliberate
    // hydration-safe patterns (e.g. computing a mailto from client-only
    // state after mount). Keep it visible as a warning; revisit per
    // component rather than blocking the Next 16 upgrade on a rewrite.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
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
