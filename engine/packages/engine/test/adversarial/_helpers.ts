// Shared assertions for the adversarial corpus. The corpus mirrors
// docs/adversarial-corpus.md one-to-one — each test is one corpus entry.

import { expect } from "bun:test";
import type { Engine, EngineContext } from "../../src/engine.ts";
import type { MemoryAuditWriter } from "../_helpers.ts";

export async function expectDeny(
  engine: Engine,
  ctx: EngineContext,
  sql: string,
  policy_rule: string,
): Promise<void> {
  const d = await engine.handle({ sql, ctx });
  expect(d.allowed).toBe(false);
  expect((d as { reason: string }).reason).toBe(policy_rule);
}

export async function expectAllow(
  engine: Engine,
  ctx: EngineContext,
  sql: string,
): Promise<void> {
  const d = await engine.handle({ sql, ctx });
  expect(d.allowed).toBe(true);
}

// Asserts the DECIDED audit event payload matches the expected shape.
// Used on representative cases per category to mirror engine.test.ts
// zod-typed payload assertions.
export function expectDecidedDeny(
  audit: MemoryAuditWriter,
  policy_rule: string,
): void {
  const decided = audit.byType("DECIDED")[0]!;
  expect(decided.payload).toMatchObject({ decision: "DENY", policy_rule });
}

export function expectDecidedAllow(
  audit: MemoryAuditWriter,
  statement_type: string,
): void {
  const decided = audit.byType("DECIDED")[0]!;
  expect(decided.payload).toMatchObject({ decision: "ALLOW", statement_type });
}
