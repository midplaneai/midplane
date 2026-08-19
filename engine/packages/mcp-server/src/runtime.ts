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

import { sep } from "node:path";
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
 * This build's entry script (`cli.ts` in a checkout, the bundled `cli.js` in
 * the npm dist), resolved relative to this module so neither shape hard-codes
 * the other's extension. Meaningless inside the compiled binary — the caller
 * must check isCompiledBinary() first.
 */
function selfEntryPath(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = here.slice(here.lastIndexOf("."));
  return fileURLToPath(new URL(`./cli${ext}`, import.meta.url));
}

/**
 * argv for re-running THIS build's `midplane server` as a child process, used
 * by `midplane query --stdio` and `doctor`'s stdio canary.
 *
 * The compiled binary is its own CLI, so it takes the subcommand directly; the
 * other two shapes need the entry script passed to the interpreter.
 */
export function selfServerSpawn(): { command: string; args: string[] } {
  if (isCompiledBinary()) {
    return { command: process.execPath, args: ["server"] };
  }
  return { command: process.execPath, args: [selfEntryPath(), "server"] };
}

/**
 * Which of the three shapes above this process is — i.e. how the user got
 * here, which is what decides what "now run it" looks like for them. The npm
 * package serves stdio and is spawned BY the agent; the image serves HTTP and
 * is run by the operator. Handing one the other's instructions sends them off
 * to install something they deliberately didn't.
 */
export type InstallShape = "docker" | "package" | "source";

export function installShape(): InstallShape {
  return isCompiledBinary() ? "docker" : shapeForEntry(selfEntryPath());
}

/**
 * Non-compiled entry path → shape. Split out from installShape() because the
 * real one can only ever report the shape of the process running the tests;
 * this takes the path as an argument, so the layouts that matter can be
 * asserted directly.
 *
 * The npm package is the only shape that lives under `node_modules` — true of
 * every way it gets installed: `npx` (unpacks into its own cache tree), `bunx`
 * (a temp dir under TMPDIR), a global install, a project dependency, pnpm's
 * store. A path that is none of those is a source checkout, and the caller
 * prints the literal interpreter + entry, which runs regardless.
 */
export function shapeForEntry(entry: string): InstallShape {
  return entry.includes(`${sep}node_modules${sep}`) ? "package" : "source";
}

/**
 * How to spell "run midplane" for THIS install, as argv — `["npx", "-y",
 * "midplane"]`, `["bun", "/path/to/cli.ts"]`, `["midplane"]`. Append a
 * subcommand for a copy-pasteable command line, or split it into an MCP
 * client's `command` + `args` pair.
 *
 * `npx -y` rather than a bare `midplane` on the package path: it is correct
 * whether or not the package is installed (npx prefers a local or PATH copy
 * before fetching), and it is the form the README and the registry entry
 * already document.
 */
export function selfCliArgv(): string[] {
  // The entry path is meaningless inside the compiled binary, so don't compute
  // one for it — the image's CLI is the binary itself.
  if (isCompiledBinary()) return cliArgvFor("docker", RUNTIME, "");
  const entry = selfEntryPath();
  return cliArgvFor(shapeForEntry(entry), RUNTIME, entry);
}

/** The mapping behind selfCliArgv(), as a pure function of the three inputs. */
export function cliArgvFor(
  shape: InstallShape,
  runtime: RuntimeName,
  entry: string,
): string[] {
  switch (shape) {
    case "docker":
      return ["midplane"];
    case "package":
      return runtime === "bun" ? ["bunx", "midplane"] : ["npx", "-y", "midplane"];
    case "source":
      return [runtime, entry];
  }
}
