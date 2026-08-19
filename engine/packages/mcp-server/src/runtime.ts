// Which JS runtime is hosting this process, and how to re-spawn it.
//
// Midplane ships in three shapes and they do not agree on any of this:
//
//   1. the `midplane/midplane` Docker image — a `bun build --compile` binary,
//      where process.execPath IS the CLI and the bundled sources live under a
//      virtual /$bunfs/ root that cannot be passed back as a script argument
//   2. `bun engine/packages/mcp-server/src/cli.ts` from a source checkout
//   3. the `midplane` npm package on Node — one bundled dist/cli.js
//
// Keeping the differences here means the rest of the CLI never branches on
// runtime.

import { fileURLToPath } from "node:url";

export type RuntimeName = "bun" | "node";

export const RUNTIME: RuntimeName =
  typeof process.versions.bun === "string" ? "bun" : "node";

/** e.g. "1.3.10" on Bun, "24.4.0" on Node — no leading "v" either way. */
export const RUNTIME_VERSION: string =
  RUNTIME === "bun"
    ? (process.versions.bun ?? "unknown")
    : process.versions.node;

/** e.g. "bun 1.3.10". For `midplane doctor` and `--help` banners. */
export function runtimeLabel(): string {
  return `${RUNTIME} ${RUNTIME_VERSION}`;
}

// `bun build --compile` rewrites module paths to a virtual filesystem root.
// import.meta.url inside the binary is file:///$bunfs/root/<entry>, which
// exists only inside that process — passing it to a child as a script path
// resolves to nothing.
const BUNFS_PREFIX = "/$bunfs/";

export function isCompiledBinary(): boolean {
  return fileURLToPath(import.meta.url).startsWith(BUNFS_PREFIX);
}

/**
 * argv for re-running THIS build's `midplane server` as a child process, used
 * by `midplane query --stdio` and `doctor`'s stdio canary.
 *
 * The compiled binary is its own CLI, so it takes the subcommand directly. The
 * other two shapes need the entry script passed to the interpreter — resolved
 * relative to this module so it picks up `cli.ts` from a source checkout and
 * the bundled `cli.js` from the npm dist, without either hard-coding the
 * other's extension.
 */
export function selfServerSpawn(): { command: string; args: string[] } {
  if (isCompiledBinary()) {
    return { command: process.execPath, args: ["server"] };
  }
  const here = fileURLToPath(import.meta.url);
  const ext = here.slice(here.lastIndexOf("."));
  const entry = fileURLToPath(new URL(`./cli${ext}`, import.meta.url));
  return { command: process.execPath, args: [entry, "server"] };
}
