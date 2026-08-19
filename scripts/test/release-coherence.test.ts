// scripts/check-image-pin.ts — the release-drift guard.
//
// One `engine-v*` tag now cuts three artifacts: the Docker image, the
// `midplane` npm package, and the MCP registry entry. Two of those are
// immutable once published, so a version that disagrees cannot be fixed in
// place — it has to be superseded by another release. That makes this check
// the last cheap place to catch it, which is why it gets tests of its own.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkReleaseCoherence,
  scanForDrift,
} from "../check-image-pin.ts";
import { OSS_ENGINE_IMAGE } from "../../packages/router/src/oss-image.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

const PIN = OSS_ENGINE_IMAGE.split("@")[0]!.split(":")[1]!;
const PKG = readJson("engine/packages/mcp-server/package.json");
const SERVER = readJson("server.json");

// A well-formed pair, derived from the real files so the fixtures can't drift
// away from the shapes actually being checked.
const okPkg = { name: "midplane", version: PIN, mcpName: "ai.midplane/midplane" };
const okServer = {
  name: "ai.midplane/midplane",
  version: PIN,
  packages: [
    { registryType: "npm", identifier: "midplane", version: PIN },
    { registryType: "oci", identifier: "midplane/midplane", version: PIN },
  ],
};

describe("checkReleaseCoherence", () => {
  it("passes on the repo's actual manifests", () => {
    expect(checkReleaseCoherence(PKG, SERVER, PIN)).toEqual([]);
  });

  it("catches an npm package version left behind by a pin bump", () => {
    const found = checkReleaseCoherence({ ...okPkg, version: "0.17.0" }, okServer, PIN);
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toContain("package.json");
    expect(found[0]!.found).toBe("0.17.0");
  });

  it("catches a server.json version left behind", () => {
    const stale = { ...okServer, version: "0.17.0" };
    expect(checkReleaseCoherence(okPkg, stale, PIN)).toHaveLength(1);
  });

  it("catches a per-package version left behind, not just the top-level one", () => {
    // The likeliest real mistake: bumping server.json's `version` and
    // forgetting the two copies inside `packages[]`, which is what the
    // registry actually resolves to a downloadable artifact.
    const stale = {
      ...okServer,
      packages: [
        { registryType: "npm", identifier: "midplane", version: "0.17.0" },
        { registryType: "oci", identifier: "midplane/midplane", version: "0.17.0" },
      ],
    };
    const found = checkReleaseCoherence(okPkg, stale, PIN);
    expect(found).toHaveLength(2);
    expect(found.every((m) => m.found === "0.17.0")).toBe(true);
  });

  // The registry proves we own the npm package by matching server.json's
  // `name` against the published package's `mcpName`. If they disagree,
  // `mcp-publisher publish` rejects the submission — AFTER npm publish has
  // already burned the version number.
  it("catches a name/mcpName mismatch", () => {
    const found = checkReleaseCoherence(
      { ...okPkg, mcpName: "io.github.midplaneai/midplane" },
      okServer,
      PIN,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.context).toContain("mcpName");
  });

  it("catches a registry entry pointing at the wrong npm package", () => {
    const wrong = {
      ...okServer,
      packages: [
        { registryType: "npm", identifier: "midplane-mcp-server", version: PIN },
        { registryType: "oci", identifier: "midplane/midplane", version: PIN },
      ],
    };
    const found = checkReleaseCoherence(okPkg, wrong, PIN);
    expect(found).toHaveLength(1);
    expect(found[0]!.context).toContain("identifier");
  });

  it("catches a missing package block rather than passing vacuously", () => {
    const noNpm = { ...okServer, packages: [okServer.packages[1]] };
    expect(checkReleaseCoherence(okPkg, noNpm, PIN)).toHaveLength(1);
    expect(checkReleaseCoherence(okPkg, { ...okServer, packages: [] }, PIN)).toHaveLength(2);
  });
});

describe("scanForDrift", () => {
  it("flags a stale image tag and ignores a matching one", () => {
    expect(scanForDrift("f.toml", `image = "midplane/midplane:0.1.0"`, PIN)).toHaveLength(1);
    expect(scanForDrift("f.toml", `image = "midplane/midplane:${PIN}"`, PIN)).toEqual([]);
  });

  it("ignores a digest suffix on an otherwise-current tag", () => {
    const text = `midplane/midplane:${PIN}@sha256:${"a".repeat(64)}`;
    expect(scanForDrift("fly-eu.toml", text, PIN)).toEqual([]);
  });

  it("checks the bare workflow input default only in deploy-fly.yml", () => {
    const yaml = `        default: "0.1.0"\n`;
    expect(scanForDrift(".github/workflows/deploy-fly.yml", yaml, PIN)).toHaveLength(1);
    // Elsewhere a bare `default:` is someone else's field, not an image pin.
    expect(scanForDrift("docs/deploy.md", yaml, PIN)).toEqual([]);
  });
});

describe("checkReleaseCoherence — OCI annotation", () => {
  const label = (v: string) =>
    `FROM alpine:3.20\nLABEL io.modelcontextprotocol.server.name="${v}"\nUSER midplane\n`;

  it("passes on the repo's actual Dockerfile", () => {
    const df = readFileSync(join(ROOT, "engine/docker/Dockerfile"), "utf8");
    expect(checkReleaseCoherence(PKG, SERVER, PIN, df)).toEqual([]);
  });

  it("catches an annotation that disagrees with the server name", () => {
    const found = checkReleaseCoherence(
      okPkg,
      okServer,
      PIN,
      label("io.github.midplaneai/midplane"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toContain("Dockerfile");
  });

  it("catches a missing annotation", () => {
    const found = checkReleaseCoherence(okPkg, okServer, PIN, "FROM alpine:3.20\n");
    expect(found).toHaveLength(1);
    expect(found[0]!.context).toContain("no io.modelcontextprotocol.server.name");
  });
});
