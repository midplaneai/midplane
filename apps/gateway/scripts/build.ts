// The npm package's build: one ESM file, bundle/cli.js, with the workspace's
// own packages (@midplane/core, @midplane/protocol) inlined and every
// third-party package left as a dependency to install. libpg-query then
// loads its WebAssembly from beside its own files, as it must, and Node
// never has to strip types inside node_modules.
//
// With --shrinkwrap, it also resolves the dependency tree once and ships it
// as npm-shrinkwrap.json, so `npx midplane` and the image install exactly
// the versions the release tested (a release builds with it).
//
//   node scripts/build.ts [--shrinkwrap]

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rolldown } from "rolldown";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  version: string;
  dependencies: Record<string, string>;
};
const deps = Object.keys(pkg.dependencies);
const builtins = new Set(builtinModules);

const external = (id: string): boolean =>
  id.startsWith("node:") ||
  builtins.has(id) ||
  deps.some((d) => id === d || id.startsWith(`${d}/`));

rmSync(join(root, "bundle"), { recursive: true, force: true });
const build = await rolldown({
  input: join(root, "src", "cli.ts"),
  platform: "node",
  external,
});
await build.write({
  dir: join(root, "bundle"),
  format: "esm",
  entryFileNames: "cli.js",
});
await build.close();
chmodSync(join(root, "bundle", "cli.js"), 0o755);
// npm wants the license beside the package; the repository keeps one copy.
copyFileSync(join(root, "..", "..", "LICENSE"), join(root, "LICENSE"));
rmSync(join(root, "npm-shrinkwrap.json"), { force: true });
if (process.argv.includes("--shrinkwrap")) {
  // Nothing published after the commit being built: a release resolves the
  // tree its commit was reviewed with, not whatever the registry holds the
  // day the tag is pushed. A copy without its repository (the monorepo's CI
  // keeps only oss/) names the commit's date in MIDPLANE_COMMIT_DATE.
  const before =
    process.env.MIDPLANE_COMMIT_DATE ||
    execFileSync("git", ["log", "-1", "--format=%cI"], { cwd: root })
      .toString()
      .trim();
  const dir = mkdtempSync(join(tmpdir(), "midplane-shrinkwrap-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: pkg.name,
      version: pkg.version,
      dependencies: pkg.dependencies,
    }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--package-lock-only",
      `--before=${before}`,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: dir, stdio: "inherit" },
  );
  copyFileSync(
    join(dir, "package-lock.json"),
    join(root, "npm-shrinkwrap.json"),
  );
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  `built bundle/cli.js${process.argv.includes("--shrinkwrap") ? " and npm-shrinkwrap.json" : ""}`,
);
