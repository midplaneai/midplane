// The MCP registry entry, server.json, against the package it names. The
// registry accepts an entry only if the npm version it names carries the
// entry's name as `mcpName`, and a published version can't be changed: so
// the entry, the package's name and version, and `mcpName` move together,
// checked here before a tag rather than by the registry after npm publish.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (file: string) =>
  JSON.parse(readFileSync(join(root, file), "utf8"));
const pkg = read("package.json");
const server = read("server.json");

describe("server.json", () => {
  it("names this package, at its version, under its mcpName", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: pkg.name,
      version: pkg.version,
    });
  });

  it("keeps the registry's limits", () => {
    expect(server.title.length).toBeLessThanOrEqual(100);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("runs local mode over stdio, with the token it needs", () => {
    const [entry] = server.packages;
    expect(entry.transport).toEqual({ type: "stdio" });
    // Fixed words are positional, with a value: clients put those on the
    // command line as they are, and may leave out a named one with no value.
    expect(
      entry.packageArguments.map(
        (a: { type: string; value?: string; name?: string }) =>
          a.type === "positional" ? a.value : a.name,
      ),
    ).toEqual(["local", "--config", "--stdio"]);
    expect(entry.environmentVariables).toEqual([
      expect.objectContaining({
        name: "MIDPLANE_TOKEN",
        isRequired: true,
        isSecret: true,
      }),
    ]);
  });
});
