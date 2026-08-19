// runtime — how this build was installed, and how to spell "run midplane" for
// it. The live functions can only ever report the shape of the process running
// the suite (a source checkout), so the mappings are exercised through their
// pure forms, with the paths taken from real installs: an `npx` cache entry, a
// `bunx` temp tree, a global install, a project dependency, a pnpm store.

import { describe, expect, test } from "bun:test";
import {
  RUNTIME,
  cliArgvFor,
  installShape,
  isCompiledBinary,
  selfServerSpawn,
  shapeForEntry,
} from "../src/runtime.ts";

describe("shapeForEntry", () => {
  // Every way the npm package reaches a machine puts it under node_modules.
  test.each([
    ["npx cache", "/Users/dev/.npm/_npx/554f376bc427315c/node_modules/midplane/dist/cli.js"],
    ["bunx temp tree", "/var/folders/mn/T/bunx-501-midplane@0.19.0/node_modules/midplane/dist/cli.js"],
    ["global install", "/usr/local/lib/node_modules/midplane/dist/cli.js"],
    ["project dependency", "/srv/app/node_modules/midplane/dist/cli.js"],
    ["pnpm store", "/srv/app/node_modules/.pnpm/midplane@0.19.0/node_modules/midplane/dist/cli.js"],
  ])("%s → package", (_label, entry) => {
    expect(shapeForEntry(entry)).toBe("package");
  });

  test("a source checkout is not a package install", () => {
    expect(shapeForEntry("/repo/engine/packages/mcp-server/src/cli.ts")).toBe("source");
  });

  // The bundle run straight out of a checkout (`node dist/cli.js`) is not an
  // install. "source" is the honest answer: the caller then prints the literal
  // interpreter + path, which is exactly what the user just ran.
  test("the built bundle run in place is source, not package", () => {
    expect(shapeForEntry("/repo/engine/packages/mcp-server/dist/cli.js")).toBe("source");
  });

  // Matched as a path segment, so a directory that merely contains the word
  // can't masquerade as an install.
  test("a directory named like node_modules doesn't count", () => {
    expect(shapeForEntry("/repo/my_node_modules_backup/src/cli.ts")).toBe("source");
  });
});

describe("cliArgvFor", () => {
  test("the image's binary is its own CLI", () => {
    expect(cliArgvFor("docker", "bun", "")).toEqual(["midplane"]);
  });

  // `npx -y` / `bunx` rather than a bare `midplane`: correct whether or not the
  // package is installed, and the form the README and registry entry document.
  test("the package is invoked through the runtime's package runner", () => {
    expect(cliArgvFor("package", "node", "/x/node_modules/midplane/dist/cli.js")).toEqual([
      "npx",
      "-y",
      "midplane",
    ]);
    expect(cliArgvFor("package", "bun", "/x/node_modules/midplane/dist/cli.js")).toEqual([
      "bunx",
      "midplane",
    ]);
  });

  test("a checkout is invoked as interpreter + entry script", () => {
    expect(cliArgvFor("source", "bun", "/repo/src/cli.ts")).toEqual(["bun", "/repo/src/cli.ts"]);
    expect(cliArgvFor("source", "node", "/repo/dist/cli.js")).toEqual(["node", "/repo/dist/cli.js"]);
  });
});

describe("this build", () => {
  test("reports itself as a source checkout under bun", () => {
    expect(isCompiledBinary()).toBe(false);
    expect(installShape()).toBe("source");
    expect(RUNTIME).toBe("bun");
  });

  // The extraction of selfEntryPath() must not have changed what `midplane
  // query --stdio` and doctor's canary spawn.
  test("still re-spawns itself as <interpreter> <entry> server", () => {
    const { command, args } = selfServerSpawn();
    expect(command).toBe(process.execPath);
    expect(args[0]).toMatch(/cli\.ts$/);
    expect(args[1]).toBe("server");
  });
});
