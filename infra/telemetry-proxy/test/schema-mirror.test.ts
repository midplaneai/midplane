// Drift detector. Fetches the upstream OSS schema.ts on the main branch and
// asserts that the locked enums (ToolName, PolicyRuleName, StatementTypeBucket)
// are byte-identical with the vendored mirror in src/schema.ts. If this fails,
// someone changed the OSS contract without updating the proxy — that's a bug,
// not a test problem.
//
// Network-dependent; soft-skips when offline so this never fails CI on a
// sandbox without egress. CI on main DOES have network and will catch drift.

import { describe, it, expect } from "vitest";
import { ToolName, PolicyRuleName, StatementTypeBucket } from "../src/schema.ts";

const UPSTREAM_URL =
  "https://raw.githubusercontent.com/midplaneai/midplane/main/packages/mcp-server/src/telemetry/schema.ts";

const FETCH_TIMEOUT_MS = 5_000;

async function fetchUpstream(): Promise<string | null> {
  try {
    const res = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractEnumValues(source: string, name: string): string[] {
  const re = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*z\\.enum\\(\\[([\\s\\S]*?)\\]\\)`);
  const m = source.match(re);
  if (!m) throw new Error(`couldn't find z.enum for ${name} in upstream schema`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("schema mirror vs OSS main", () => {
  it("ToolName / PolicyRuleName / StatementTypeBucket match upstream", async () => {
    const upstream = await fetchUpstream();
    if (!upstream) {
      console.warn(`[schema-mirror] skipped: could not fetch ${UPSTREAM_URL}`);
      return;
    }

    expect(extractEnumValues(upstream, "ToolName")).toEqual([...ToolName.options]);
    expect(extractEnumValues(upstream, "PolicyRuleName")).toEqual([...PolicyRuleName.options]);
    expect(extractEnumValues(upstream, "StatementTypeBucket")).toEqual([
      ...StatementTypeBucket.options,
    ]);
  });
});
