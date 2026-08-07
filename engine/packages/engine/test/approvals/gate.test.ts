// Write-approval gate — the stage between policy ALLOW and execute.
//
// The invariants under test, in rough order of how badly a regression would hurt:
//   1. Approvals never resurrect a policy denial, and never let a write through
//      without an answer.
//   2. A non-decision (gate down, nobody ruled yet) is never recorded as a
//      denial — no DECIDED row at all, so no deny-webhook and no phantom
//      refusal in a compliance export.
//   3. A write hidden in a CTE is still a write.
//   4. Approvals off is byte-for-byte the old pipeline.

import { describe, expect, test } from "bun:test";
import { makeEngine, baseCtx } from "../_helpers.ts";
import { tableAccess } from "../../src/policy/rules/table-access.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { dangerousStatement } from "../../src/policy/rules/dangerous-statement.ts";
import { ApprovalPendingError, ApprovalUnavailableError } from "../../src/errors.ts";
import type { ApprovalGate, ApprovalOutcome, ApprovalRequest } from "../../src/approvals.ts";

/** Records what it was asked and answers however the test says. */
class StubGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalOutcome | (() => never)) {}
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    this.seen.push(req);
    if (typeof this.answer === "function") this.answer();
    return this.answer;
  }
}

const APPROVED: ApprovalOutcome = { status: "approved", by: "dustin@example.com", note: null };
const WRITABLE = { default: "read_write" as const, tables: {} };

// Guardrails would block an unqualified UPDATE before approvals ever ran, so
// every write here carries a WHERE clause.
const WRITE_SQL = "UPDATE orders SET status='refunded' WHERE id=1";

function harness(answer: ApprovalOutcome | (() => never), writes = true) {
  const gate = new StubGate(answer);
  const h = makeEngine({
    tableAccess: WRITABLE,
    approvals: { config: { writes }, gate },
  });
  return { ...h, gate };
}

describe("when approvals are off", () => {
  test("a write runs without ever consulting the gate", async () => {
    const { engine, audit, gate } = harness(APPROVED, false);
    const d = await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });

    expect(d.allowed).toBe(true);
    expect(gate.seen).toHaveLength(0);
    expect(audit.events.map((e) => e.event_type)).toEqual([
      "ATTEMPTED",
      "DECIDED",
      "EXECUTED",
    ]);
  });
});

describe("what gets asked about", () => {
  test("a read is never held, even with approvals on", async () => {
    const { engine, gate } = harness(APPROVED);
    const d = await engine.handle({ sql: "SELECT * FROM orders", ctx: baseCtx });
    expect(d.allowed).toBe(true);
    expect(gate.seen).toHaveLength(0);
  });

  test("a write hidden in a CTE is still held", async () => {
    // auditStatementType is "SELECT" here. A gate keyed on the statement keyword
    // would wave this through while it deletes rows.
    const { engine, gate } = harness(APPROVED);
    await engine.handle({
      sql: "WITH d AS (DELETE FROM orders WHERE id=1 RETURNING *) SELECT count(*) FROM d",
      ctx: baseCtx,
    });
    expect(gate.seen).toHaveLength(1);
    expect(gate.seen[0]!.statementType).toBe("SELECT");
  });

  test("the gate is told what a human needs, and never a credential", async () => {
    const { engine, gate } = harness(APPROVED);
    await engine.handle({ sql: WRITE_SQL, ctx: { ...baseCtx, agent_intent: "refund dupes" } });

    const req = gate.seen[0]!;
    expect(req.sql).toBe(WRITE_SQL);
    expect(req.statementType).toBe("UPDATE");
    expect(req.tablesTouched).toContain("orders");
    expect(req.agentName).toBe("test-agent");
    expect(req.database).toBeTruthy();
    expect(req.queryId).toBeTruthy();
    expect(JSON.stringify(req)).not.toContain("postgres://");
  });
});

describe("approvals sit under the policy, never over it", () => {
  test("a table_access denial never reaches a human", async () => {
    const gate = new StubGate(APPROVED);
    const { engine, audit } = makeEngine({
      tableAccess: { default: "read", tables: {} }, // no write anywhere
      approvals: { config: { writes: true }, gate },
    });

    const d = await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });

    expect(d.allowed).toBe(false);
    expect(gate.seen).toHaveLength(0);
    const decided = audit.byType("DECIDED")[0]!;
    expect(decided.payload).toMatchObject({ decision: "DENY", policy_rule: "table_access" });
  });

  test("a guardrail denial never reaches a human", async () => {
    const gate = new StubGate(APPROVED);
    const { engine } = makeEngine({
      tableAccess: WRITABLE,
      approvals: { config: { writes: true }, gate },
      rules: [
        parseError(),
        multiStatement(),
        tableAccess(WRITABLE),
        dangerousStatement({ blockUnqualifiedDml: true, blockDdl: true }),
      ],
    });

    // No WHERE — the guardrail refuses it outright. An approval must not be
    // able to buy a way past that.
    const d = await engine.handle({ sql: "UPDATE orders SET status='x'", ctx: baseCtx });

    expect(d.allowed).toBe(false);
    expect(gate.seen).toHaveLength(0);
  });
});

describe("approved", () => {
  test("executes and records an ordinary ALLOW", async () => {
    const { engine, audit, executor } = harness(APPROVED);
    const d = await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });

    expect(d.allowed).toBe(true);
    expect(executor.calls).toHaveLength(1);
    expect(audit.events.map((e) => e.event_type)).toEqual([
      "ATTEMPTED",
      "DECIDED",
      "EXECUTED",
    ]);
    // No new audit vocabulary: an approved write is indistinguishable from any
    // other allowed one, which is what keeps the /audit surface unchanged.
    expect(audit.byType("DECIDED")[0]!.payload).toMatchObject({ decision: "ALLOW" });
  });
});

describe("denied", () => {
  test("refuses, does not execute, and records approval_denied", async () => {
    const { engine, audit, executor } = harness({
      status: "denied",
      by: "tom@example.com",
      note: "use the refunds table",
    });

    const d = await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });

    expect(d.allowed).toBe(false);
    expect(executor.calls).toHaveLength(0);
    const decided = audit.byType("DECIDED")[0]!;
    expect(decided.payload).toMatchObject({
      decision: "DENY",
      policy_rule: "approval_denied",
    });
    // Exactly one decision for the attempt — no ALLOW row later corrected.
    expect(audit.byType("DECIDED")).toHaveLength(1);
  });

  test("the approver's note reaches the agent", async () => {
    // A denial that explains itself is what lets an agent write a better
    // statement instead of retrying the same one.
    const { engine } = harness({
      status: "denied",
      by: "tom@example.com",
      note: "use the refunds table",
    });
    const d = await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });
    expect(d.allowed).toBe(false);
    if (d.allowed) throw new Error("unreachable");
    expect(d.message).toContain("use the refunds table");
    expect(d.message).toContain("tom@example.com");
  });

  test("a note-less denial still says who", async () => {
    const { engine } = harness({ status: "denied", by: "tom@example.com", note: "   " });
    const d = await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });
    if (d.allowed) throw new Error("unreachable");
    expect(d.message).toContain("tom@example.com");
  });
});

describe("expired", () => {
  test("refuses with approval_expired and invites a retry", async () => {
    const { engine, audit, executor } = harness({ status: "expired" });
    const d = await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });

    expect(d.allowed).toBe(false);
    expect(executor.calls).toHaveLength(0);
    expect(audit.byType("DECIDED")[0]!.payload).toMatchObject({
      policy_rule: "approval_expired",
    });
    if (d.allowed) throw new Error("unreachable");
    expect(d.message).toMatch(/re-run/i);
  });
});

describe("the two non-decisions", () => {
  test("pending throws, does NOT execute, and writes no DECIDED row", async () => {
    // The deny-webhook fires on every DECIDED+DENY. A held write must not trip
    // it — nobody refused this.
    const expiresAt = 1_700_000_900_000;
    const { engine, audit, executor } = harness({
      status: "pending",
      approvalId: "apr_7Kq2vX",
      expiresAt,
      reviewUrl: "https://app.midplane.ai/approvals/apr_7Kq2vX",
    });

    await expect(engine.handle({ sql: WRITE_SQL, ctx: baseCtx })).rejects.toThrow(
      ApprovalPendingError,
    );

    expect(executor.calls).toHaveLength(0);
    expect(audit.byType("DECIDED")).toHaveLength(0);
    // The attempt is still recorded — intent is never lost.
    expect(audit.map ? true : true).toBe(true);
    expect(audit.byType("ATTEMPTED")).toHaveLength(1);
  });

  test("pending carries what the agent needs to come back", async () => {
    const { engine } = harness({
      status: "pending",
      approvalId: "apr_7Kq2vX",
      expiresAt: 1_700_000_900_000,
      reviewUrl: "https://app.midplane.ai/approvals/apr_7Kq2vX",
    });

    try {
      await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApprovalPendingError);
      const e = err as ApprovalPendingError;
      expect(e.code).toBe("approval_pending");
      expect(e.details.approvalId).toBe("apr_7Kq2vX");
      expect(e.details.expiresAt).toBe(1_700_000_900_000);
      expect(e.details.reviewUrl).toContain("apr_7Kq2vX");
      expect(e.message).toMatch(/re-run/i);
    }
  });

  test("an unreachable gate throws, does NOT execute, and writes no DECIDED row", async () => {
    const { engine, audit, executor } = harness(() => {
      throw new ApprovalUnavailableError("control plane unreachable");
    });

    await expect(engine.handle({ sql: WRITE_SQL, ctx: baseCtx })).rejects.toThrow(
      ApprovalUnavailableError,
    );

    expect(executor.calls).toHaveLength(0);
    expect(audit.byType("DECIDED")).toHaveLength(0);
    expect(audit.byType("ATTEMPTED")).toHaveLength(1);
  });

  test("approvals on with NO gate injected refuses rather than executing", async () => {
    // A deployment fault must not read as permission.
    const { engine, executor } = makeEngine({
      tableAccess: WRITABLE,
      approvals: { config: { writes: true } }, // no gate
    });

    await expect(engine.handle({ sql: WRITE_SQL, ctx: baseCtx })).rejects.toThrow(
      ApprovalUnavailableError,
    );
    expect(executor.calls).toHaveLength(0);
  });
});

describe("hot-reload", () => {
  test("flipping the config getter changes behaviour on the NEXT statement", async () => {
    // Approvals live in the policy YAML, so a toggle arrives by hot-reload. The
    // engine reads the config through a getter for exactly this reason: if it
    // captured the value at construction, enabling approvals would land in the
    // control plane and never reach a warm container — writes would keep
    // running unapproved until the next respawn.
    const gate = new StubGate(APPROVED);
    let writes = false;
    const { engine, executor } = makeEngine({
      tableAccess: WRITABLE,
      approvals: { config: () => ({ writes }), gate },
    });

    await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });
    expect(gate.seen).toHaveLength(0);
    expect(executor.calls).toHaveLength(1);

    writes = true; // the hot-reload

    await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });
    expect(gate.seen).toHaveLength(1);
  });

  test("turning approvals back off stops asking", async () => {
    const gate = new StubGate(APPROVED);
    let writes = true;
    const { engine } = makeEngine({
      tableAccess: WRITABLE,
      approvals: { config: () => ({ writes }), gate },
    });

    await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });
    expect(gate.seen).toHaveLength(1);

    writes = false;
    await engine.handle({ sql: WRITE_SQL, ctx: baseCtx });
    expect(gate.seen).toHaveLength(1);
  });
});
