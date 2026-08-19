#!/usr/bin/env bun
// Validates server.json against the official MCP registry schema.
//
//   bun scripts/check-server-json.ts
//
// The schema is fetched from the URL server.json declares in its own `$schema`
// field, rather than vendored — a vendored copy silently goes stale, and being
// stale is the one thing that makes this check worse than useless.
//
// Network failure is a SKIP, not a failure: the authoritative validation runs
// server-side at `mcp-publisher publish`. This exists to move that feedback
// earlier, to the PR that edits server.json, instead of the release job that
// discovers it after `npm publish` has already burned a version.
//
// Field-level coherence (versions, name↔mcpName, npm identifier) is checked
// separately and without network in scripts/check-image-pin.ts.

import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const doc = JSON.parse(readFileSync(join(root, "server.json"), "utf8")) as {
  $schema?: string;
};

if (!doc.$schema) {
  console.error("[check-server-json] server.json has no $schema — cannot validate");
  process.exit(1);
}

let schema: object;
try {
  const res = await fetch(doc.$schema, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  schema = (await res.json()) as object;
} catch (err) {
  console.warn(
    `[check-server-json] SKIP: could not fetch ${doc.$schema} (${(err as Error).message})`,
  );
  process.exit(0);
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(doc)) {
  console.error(`[check-server-json] server.json is INVALID against ${doc.$schema}:`);
  for (const e of validate.errors ?? []) {
    console.error(`  ${e.instancePath || "(root)"}: ${e.message} ${JSON.stringify(e.params)}`);
  }
  process.exit(1);
}

console.log(`[check-server-json] OK: server.json validates against ${doc.$schema}`);
