// Proves the dependency rules bite: the lint layer (biome.json) and the
// manifest layer (scripts/check-boundaries.ts) each reject what they guard.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkManifest,
  checkPublished,
  checkPureTsConfig,
  checkWorkspace,
  type Manifest,
} from "../scripts/check-boundaries.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const biome = join(root, "node_modules", ".bin", "biome");

const PACKAGE_NAMES: Record<string, string> = {
  "packages/core": "@midplane/core",
  "packages/protocol": "@midplane/protocol",
  "apps/gateway": "midplane",
};

/**
 * Lints one source file placed at `path` inside a scratch copy of the
 * workspace config, and returns the rule categories Biome reported.
 */
function lint(path: string, source: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "midplane-lint-"));
  try {
    copyFileSync(join(root, "biome.json"), join(dir, "biome.json"));
    writeFileSync(join(dir, "package.json"), '{ "name": "scratch" }');
    for (const [pkg, name] of Object.entries(PACKAGE_NAMES)) {
      mkdirSync(join(dir, pkg), { recursive: true });
      writeFileSync(join(dir, pkg, "package.json"), JSON.stringify({ name }));
    }
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), source);
    const result = spawnSync(biome, ["lint", "--reporter=json", path], {
      cwd: dir,
      encoding: "utf8",
    });
    const report = JSON.parse(result.stdout) as {
      diagnostics: { category: string }[];
    };
    return report.diagnostics.map((d) => d.category);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("lint layer", () => {
  const core = "packages/core/src/probe.ts";
  const protocol = "packages/protocol/src/probe.ts";
  const gateway = "apps/gateway/src/probe.ts";

  it.each([
    [
      core,
      'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n',
      "lint/correctness/noNodejsModules",
    ],
    [
      protocol,
      'import { connect } from "node:net";\nexport const x = connect;\n',
      "lint/correctness/noNodejsModules",
    ],
    [
      core,
      'import pg from "pg";\nexport const x = pg;\n',
      "lint/style/noRestrictedImports",
    ],
    [
      core,
      "export const x = process.env.X;\n",
      "lint/style/noRestrictedGlobals",
    ],
    [core, "export const x = fetch;\n", "lint/style/noRestrictedGlobals"],
    [core, "export const x = Date.now();\n", "lint/style/noRestrictedGlobals"],
    [
      core,
      "export const x = Math.random();\n",
      "lint/nursery/noJsRestrictedProperties",
    ],
    [
      gateway,
      'import { x } from "@midplane-cloud/db";\nexport const y = x;\n',
      "lint/style/noRestrictedImports",
    ],
    [
      gateway,
      'import { x } from "@midplane/cloud-app";\nexport const y = x;\n',
      "lint/style/noRestrictedImports",
    ],
  ])("%s rejects: %s", (path, source, rule) => {
    expect(lint(path, source)).toContain(rule);
  });

  it("passes clean pure code", () => {
    expect(lint(core, "export const x = Math.max(1, 2);\n")).toEqual([]);
  });

  it("lets the gateway use Node builtins", () => {
    const source =
      'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n';
    expect(lint(gateway, source)).toEqual([]);
  });
});

describe("manifest layer", () => {
  const options = { root: "/ws/oss", allowLinkRoots: [] };

  it("keeps pure packages to their dependency allowlist", () => {
    const errors = checkManifest(
      { name: "@midplane/core", dependencies: { pg: "8.0.0" } },
      "/ws/oss/packages/core",
      options,
    );
    expect(errors).toEqual([expect.stringContaining("may not depend on pg")]);
    expect(
      checkManifest(
        { name: "@midplane/protocol", dependencies: { zod: "4.0.0" } },
        "/ws/oss/packages/protocol",
        options,
      ),
    ).toEqual([]);
  });

  it("rejects the old tree as a dependency", () => {
    const errors = checkManifest(
      { name: "midplane", devDependencies: { "@midplane-cloud/db": "*" } },
      "/ws/oss/apps/gateway",
      options,
    );
    expect(errors).toEqual([expect.stringContaining("names the old tree")]);
  });

  it("keeps path dependencies inside the workspace", () => {
    const manifest = {
      name: "midplane",
      dependencies: { x: "link:../../../cloud/db" },
    };
    expect(checkManifest(manifest, "/ws/oss/apps/gateway", options)).toEqual([
      expect.stringContaining("points outside the workspace"),
    ]);
    expect(
      checkManifest(manifest, "/ws/oss/apps/gateway", {
        ...options,
        allowLinkRoots: ["/ws/cloud"],
      }),
    ).toEqual([]);
  });

  it("stops a pure package from widening its ambient types", () => {
    const base = { compilerOptions: { types: [], lib: ["ES2024"] } };
    expect(
      checkPureTsConfig(
        "@midplane/core",
        { compilerOptions: { types: ["node"] } },
        base,
      ),
    ).toHaveLength(1);
    expect(
      checkPureTsConfig(
        "@midplane/core",
        {},
        { compilerOptions: { lib: ["ES2024", "DOM"] } },
      ),
    ).toHaveLength(2);
    expect(checkPureTsConfig("@midplane/core", {}, base)).toEqual([]);
  });

  it("keeps a published package's pins equal to the pure packages it bundles", () => {
    const byName = new Map<string, Manifest>([
      [
        "@midplane/core",
        {
          name: "@midplane/core",
          dependencies: {
            "@midplane/protocol": "workspace:*",
            "libpg-query": "18.1.5",
          },
        },
      ],
      [
        "@midplane/protocol",
        { name: "@midplane/protocol", dependencies: { zod: "4.6.5" } },
      ],
    ]);
    const gateway = {
      name: "midplane",
      publishConfig: {},
      devDependencies: { "@midplane/core": "workspace:*" },
      dependencies: { "libpg-query": "18.1.5", zod: "4.6.5" },
    };
    expect(checkPublished(gateway, byName)).toEqual([]);
    expect(
      checkPublished(
        { ...gateway, dependencies: { "libpg-query": "18.1.4" } },
        byName,
      ),
    ).toEqual([
      // Depth first: core's own workspace dependency, then its own pins.
      "midplane: bundles @midplane/protocol, so it must depend on zod 4.6.5 (has none)",
      "midplane: bundles @midplane/core, so it must depend on libpg-query 18.1.5 (has 18.1.4)",
    ]);
    expect(
      checkPublished(
        {
          ...gateway,
          dependencies: {
            ...gateway.dependencies,
            "@midplane/core": "workspace:*",
          },
        },
        byName,
      ),
    ).toEqual([
      "midplane: is published, so @midplane/core must be bundled (a devDependency), not a runtime dependencies",
    ]);
  });

  it("holds for this workspace", () => {
    expect(checkWorkspace({ root, allowLinkRoots: [] })).toEqual([]);
  });
});
