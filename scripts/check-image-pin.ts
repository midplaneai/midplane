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
  ".env.self-host.example",
  "fly-eu.toml",
  "fly-us.toml",
  "fly-web-eu.toml",
  "fly-web-us.toml",
  "README.md",
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
