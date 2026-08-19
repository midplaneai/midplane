#!/usr/bin/env bun
// Builds the publishable `midplane` npm package into dist/.
//
//   bun engine/packages/mcp-server/scripts/build-npm.ts
//
// The npm artifact is a Node artifact: `npx midplane` runs under whatever node
// the user has, not under Bun. So this bundles for --target=node and inlines
// the workspace-internal @midplane/engine (which is never published), while
// leaving the eight real runtime dependencies external so they install and
// audit normally — a vendored copy of pg inside our tarball would hide it from
// `npm audit` and from Dependabot.
//
// Not minified on purpose. This is a security tool; someone evaluating what
// `npx midplane` actually does should be able to read the published artifact.
//
// The Docker image does NOT use this script — it compiles src/cli.ts straight
// to a self-contained binary (engine/docker/Dockerfile). Two build paths, one
// source tree.

import { chmodSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = join(PKG_DIR, "dist");
const ENTRY = join(PKG_DIR, "src", "cli.ts");
const OUT = join(DIST, "cli.js");

const pkg = (await Bun.file(join(PKG_DIR, "package.json")).json()) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  dependencies: Record<string, string>;
};

// Everything in `dependencies` stays external; everything else (i.e.
// @midplane/engine, a devDependency) gets inlined. Deriving the list from the
// manifest means a new dependency can't be silently bundled — or silently
// omitted from what the consumer installs.
const external = Object.keys(pkg.dependencies).flatMap((d) => [d, `${d}/*`]);

rmSync(DIST, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [ENTRY],
  outdir: DIST,
  target: "node",
  format: "esm",
  external,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("bundle failed");
}

let code = await Bun.file(OUT).text();

// The source shebang is `#!/usr/bin/env bun` — correct for `./src/cli.ts` in a
// checkout, wrong for the thing npm links onto a user's PATH.
const NODE_SHEBANG = "#!/usr/bin/env node";
code = code.startsWith("#!")
  ? NODE_SHEBANG + code.slice(code.indexOf("\n"))
  : `${NODE_SHEBANG}\n${code}`;

await Bun.write(OUT, code);
chmodSync(OUT, 0o755);

// ── Post-conditions ─────────────────────────────────────────────────────────
//
// These are the failure modes that would ship a package that installs fine and
// then dies on first run, which is the worst way to fail — so assert them here
// rather than discovering them from a user's bug report.

const problems: string[] = [];

// A `bun:` specifier reaching Node is ERR_UNSUPPORTED_ESM_URL_SCHEME at import
// time. The sqlite driver resolves its builtin through a computed specifier
// precisely so this can't happen; this catches a future literal import.
for (const m of code.matchAll(/(?:from\s*|import\s*\(\s*)["'](bun:[^"']+)["']/g)) {
  problems.push(`bundle imports the Bun builtin "${m[1]}" — Node cannot load it`);
}

if (!code.includes(NODE_SHEBANG)) problems.push("missing node shebang");

// The version is inlined from package.json at build time (`midplane version`,
// the MCP server's advertised version, the telemetry `version` field). A stale
// bundle would report the wrong one.
if (!code.includes(pkg.version)) {
  problems.push(`bundle does not carry version ${pkg.version}`);
}

const binTarget = join(PKG_DIR, pkg.bin.midplane!);
if (!existsSync(binTarget)) problems.push(`bin target missing: ${pkg.bin.midplane}`);

for (const f of ["README.md", "LICENSE"]) {
  if (!existsSync(join(PKG_DIR, f))) {
    problems.push(`${f} is missing — it is listed in "files" and npm would omit it`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`[build-npm] ${p}`);
  process.exit(1);
}

const bytes = Buffer.byteLength(code);
console.log(
  `[build-npm] ${pkg.name}@${pkg.version} → dist/cli.js (${(bytes / 1024).toFixed(0)} KB, ${external.length / 2} external deps)`,
);
