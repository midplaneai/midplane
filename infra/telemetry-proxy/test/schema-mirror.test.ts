// Drift detector. The proxy vendors a byte-identical mirror of the OSS engine's
// telemetry enums (ToolName, PolicyRuleName, StatementTypeBucket) in
// src/schema.ts. If the engine changes the contract and the mirror isn't
// updated in lockstep, the proxy silently drops events whose enum values it
// doesn't recognize — a bug, not a test problem.
//
// Post-monorepo-merge the engine schema is IN-TREE, so this is a local import
// compare: no network, no offline-skip, fails at test time on any drift.
// (Before the merge this fetched the schema over HTTP from GitHub and
// soft-skipped when offline — which meant drift could land unnoticed on a
// sandbox without egress.)

import { describe, it, expect } from "vitest";

import {
  ToolName as MirrorToolName,
  PolicyRuleName as MirrorPolicyRuleName,
  StatementTypeBucket as MirrorStatementTypeBucket,
} from "../src/schema.ts";
import {
  ToolName as EngineToolName,
  PolicyRuleName as EnginePolicyRuleName,
  StatementTypeBucket as EngineStatementTypeBucket,
} from "../../../engine/packages/mcp-server/src/telemetry/schema.ts";

describe("schema mirror vs in-tree OSS engine", () => {
  it("ToolName / PolicyRuleName / StatementTypeBucket match the engine", () => {
    expect([...MirrorToolName.options]).toEqual([...EngineToolName.options]);
    expect([...MirrorPolicyRuleName.options]).toEqual([...EnginePolicyRuleName.options]);
    expect([...MirrorStatementTypeBucket.options]).toEqual([
      ...EngineStatementTypeBucket.options,
    ]);
  });
});
