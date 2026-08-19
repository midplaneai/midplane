#!/usr/bin/env bun
// CI drift check for the OSS engine image pin.
//
// OSS_ENGINE_IMAGE (packages/router/src/oss-image.ts) is the single source of
// truth for the engine image tag. The TS spawners import it directly, but the
// Fly configs, shell scripts, .env examples, docs, and the deploy workflow
// default can't import TS — they carry the version as a literal. This script
// fails CI if any of those AUTHORITATIVE sites disagrees with the constant.
//
// Test fixtures (packages/router/test/spawner-*.test.ts) are intentionally NOT
// checked: they exercise version-comparison logic with multiple versions
// (0.8.0 vs the current pin) and the current-pin references already import the
// constant. The engine subtree (engine/**) ships its own image and is excluded.
//
// One engine release now goes out as THREE artifacts — the Docker image, the
// `midplane` npm package, and the MCP registry entry — cut from the same
// `engine-v*` tag. checkReleaseCoherence() below holds their versions and
// identifiers together, because the failure mode is silent: `npx midplane`
// reporting a version the image never shipped, or a registry entry pointing at
// an npm version that does not exist.
//
//   bun scripts/check-image-pin.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { OSS_ENGINE_IMAGE } from "../packages/router/src/oss-image.ts";

// Pin version = the tag, ignoring any @sha256 digest suffix.
const PIN_VERSION = OSS_ENGINE_IMAGE.split("@")[0]!.split(":")[1]!;

// Authoritative sites that must agree with the pin. (Globs would also sweep the
// test fixtures + this file + oss-image.ts; an explicit list keeps intent clear.)
const SITES = [
  "scripts/dev-image.sh",
  "scripts/bootstrap.sh",
  ".env.example",
  // .env.self-host.example no longer pins the image: self-host process-spawns
  // the in-image compiled binary (ProcessSpawner), so there is no image tag to
  // drift there.
  "fly-eu.toml",
  "fly-us.toml",
  "fly-web-eu.toml",
  "fly-web-us.toml",
  "README.md",
  // The ops runbook carries prod MIDPLANE_OSS_IMAGE literals in copy-pasteable
  // `fly secrets set` blocks, so a stale tag here is a stale tag an operator
  // pastes into prod during bootstrap or manual recovery. It was bumped by hand
  // for three releases before this; the scanner validates the tag part only, so
  // the bare-tag bootstrap examples (no digest to reference before the first
  // deploy) pass unchanged.
  "docs/deploy.md",
  ".github/workflows/deploy-fly.yml",
  "e2e/hot-policy-reload.live.e2e.ts",
  "e2e/mcp-proxy.live.e2e.ts",
];

export interface Mismatch {
  path: string;
  found: string;
  context: string;
}

// Pure, unit-testable: find every concrete engine-version reference in `text`
// that disagrees with `pinVersion`. Matches `midplane/midplane:X.Y.Z` anywhere
// and, for the deploy workflow, the bare `default: "X.Y.Z"` input default.
export function scanForDrift(
  path: string,
  text: string,
  pinVersion: string,
): Mismatch[] {
  const out: Mismatch[] = [];
  const tagRe = /midplane\/midplane:(\d+\.\d+\.\d+)/g;
  for (const m of text.matchAll(tagRe)) {
    if (m[1] !== pinVersion) {
      out.push({ path, found: m[1]!, context: m[0]! });
    }
  }
  if (path.endsWith("deploy-fly.yml")) {
    // The image_tag input default is a bare version, not a midplane/ tag.
    const defRe = /default:\s*"(\d+\.\d+\.\d+)"/g;
    for (const m of text.matchAll(defRe)) {
      if (m[1] !== pinVersion) {
        out.push({ path, found: m[1]!, context: `default: "${m[1]}"` });
      }
    }
  }
  return out;
}

// The npm package manifest and the MCP registry entry carry the release version
// in structured fields rather than as free text, so they get an exact check
// instead of the regex scan. Also asserts the two identity rules the official
// registry enforces at publish time — server.json's `name` must equal the npm
// package's `mcpName` (that pairing is how the registry proves we own the npm
// package), and the npm package block must point at the package we publish.
// Both are cheap to verify here and expensive to discover mid-release.
export function checkReleaseCoherence(
  pkg: Record<string, unknown>,
  server: Record<string, unknown>,
  pinVersion: string,
  dockerfile?: string,
): Mismatch[] {
  const out: Mismatch[] = [];
  const PKG = "engine/packages/mcp-server/package.json";
  const SRV = "server.json";
  const packages = (server.packages ?? []) as Array<Record<string, unknown>>;
  const npmPkg = packages.find((p) => p.registryType === "npm");
  const ociPkg = packages.find((p) => p.registryType === "oci");

  const eq = (path: string, label: string, found: unknown, want: string) => {
    if (found !== want) {
      out.push({ path, found: String(found), context: `${label} (want ${want})` });
    }
  };

  eq(PKG, "version", pkg.version, pinVersion);
  eq(SRV, "version", server.version, pinVersion);

  if (!npmPkg) {
    out.push({ path: SRV, found: "none", context: "no npm package block" });
  } else {
    eq(SRV, "packages[npm].version", npmPkg.version, pinVersion);
    eq(SRV, "packages[npm].identifier", npmPkg.identifier, String(pkg.name));
  }

  if (!ociPkg) {
    out.push({ path: SRV, found: "none", context: "no oci package block" });
  } else {
    // OCI blocks carry no `version` field — the official registry rejects one,
    // and rejects `registryBaseUrl` too, requiring instead a canonical
    // reference that embeds the registry host and the tag:
    //   docker.io/midplane/midplane:X.Y.Z
    // So the version to check lives inside the identifier.
    if (ociPkg.registryBaseUrl !== undefined) {
      out.push({
        path: SRV,
        found: String(ociPkg.registryBaseUrl),
        context: "packages[oci].registryBaseUrl (the registry rejects this field; put the host in identifier)",
      });
    }
    if (ociPkg.version !== undefined) {
      out.push({
        path: SRV,
        found: String(ociPkg.version),
        context: "packages[oci].version (the registry rejects this field; the tag belongs in identifier)",
      });
    }
    const ref = String(ociPkg.identifier ?? "");
    const tag = ref.match(/^docker\.io\/midplane\/midplane:(\d+\.\d+\.\d+)$/)?.[1];
    if (!tag) {
      out.push({
        path: SRV,
        found: ref || "none",
        context: "packages[oci].identifier (want docker.io/midplane/midplane:X.Y.Z)",
      });
    } else {
      eq(SRV, "packages[oci].identifier tag", tag, pinVersion);
    }
  }

  // Registry ownership. The registry proves we own each artifact by matching
  // the server name against something inside it: `mcpName` in the published
  // npm package, and an OCI annotation on the image. Without both, `mcp-publisher
  // publish` rejects the submission — after npm publish has already happened
  // and is immutable.
  eq(PKG, "mcpName", pkg.mcpName, String(server.name));

  if (dockerfile !== undefined) {
    const DF = "engine/docker/Dockerfile";
    const label = dockerfile.match(
      /LABEL\s+io\.modelcontextprotocol\.server\.name="([^"]*)"/,
    );
    if (!label) {
      out.push({
        path: DF,
        found: "none",
        context: "no io.modelcontextprotocol.server.name LABEL",
      });
    } else {
      eq(DF, "io.modelcontextprotocol.server.name", label[1], String(server.name));
    }
  }

  return out;
}

function main(): void {
  const root = join(import.meta.dir, "..");
  const mismatches: Mismatch[] = [];
  for (const site of SITES) {
    let text: string;
    try {
      text = readFileSync(join(root, site), "utf8");
    } catch {
      console.error(`[check-image-pin] WARN: ${site} not found (skipped)`);
      continue;
    }
    mismatches.push(...scanForDrift(site, text, PIN_VERSION));
  }

  mismatches.push(
    ...checkReleaseCoherence(
      JSON.parse(
        readFileSync(join(root, "engine/packages/mcp-server/package.json"), "utf8"),
      ),
      JSON.parse(readFileSync(join(root, "server.json"), "utf8")),
      PIN_VERSION,
      readFileSync(join(root, "engine/docker/Dockerfile"), "utf8"),
    ),
  );

  if (mismatches.length > 0) {
    console.error(
      `[check-image-pin] DRIFT: ${mismatches.length} site(s) disagree with ` +
        `OSS_ENGINE_IMAGE (pin = ${PIN_VERSION}):`,
    );
    for (const m of mismatches) {
      console.error(`  ${m.path}: found ${m.found} (${m.context})`);
    }
    console.error(
      `Fix: bump these to ${PIN_VERSION}, or update OSS_ENGINE_IMAGE if the pin moved.`,
    );
    process.exit(1);
  }
  console.log(`[check-image-pin] OK: all sites pinned to ${PIN_VERSION}.`);
}

if (import.meta.main) main();
