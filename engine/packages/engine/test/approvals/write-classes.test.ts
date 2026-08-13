// Per-write-class routing — which statements each rule reaches.
//
// The classes are refuse/ask/allow values of one rule per class, so the two
// halves have to agree on what a statement IS. These tests pin that agreement
// from both sides: the guardrail that refuses a class, and the approval stage
// that holds it.
//
// The failure this suite exists to catch is asymmetric. Holding too much is
// annoying; holding too little runs an unreviewed write. So every "is not held"
// assertion here is paired with the "is held" case that proves the classifier
// saw the statement at all.

import { describe, expect, test } from "bun:test";
import { makeEngine, baseCtx } from "../_helpers.ts";
import { tableAccess } from "../../src/policy/rules/table-access.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { dangerousStatement } from "../../src/policy/rules/dangerous-statement.ts";
import type {
  ApprovalConfig,
  ApprovalGate,
  ApprovalOutcome,
  ApprovalRequest,
} from "../../src/approvals.ts";

class StubGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  async request(req: ApprovalRequest): Promise<ApprovalOutcome> {
    this.seen.push(req);
    return { status: "approved", by: "dustin@example.com", note: null };
  }
}

const WRITABLE = { default: "read_write" as const, tables: {} };

const NONE: ApprovalConfig = {
  rowChanges: false,
  wholeTableWrites: false,
  schemaChanges: false,
};

const ROW_CHANGE = "UPDATE orders SET status='refunded' WHERE id=1";
const INSERT = "INSERT INTO orders (id) VALUES (1)";
const WHOLE_TABLE = "DELETE FROM orders";
const SCHEMA = "DROP TABLE orders";
const CREATE = "CREATE TABLE staging (id int)";
// The reason the classifier reads write sites and not the statement keyword:
// this reports SELECT and deletes rows.
const HIDDEN_ROW_CHANGE =
  "WITH d AS (DELETE FROM orders WHERE id=1 RETURNING *) SELECT count(*) FROM d";

/** Engine with every guardrail off, so approvals are the only thing that can
 *  stop a statement and a "not held" result means genuinely unheld. */
function askEngine(config: ApprovalConfig) {
  const gate = new StubGate();
  const h = makeEngine({
    tableAccess: WRITABLE,
    rules: [
      parseError(),
      multiStatement(),
      tableAccess(WRITABLE),
      dangerousStatement({
        blockUnqualifiedDml: false,
        blockDdl: false,
        blockDml: false,
      }),
    ],
    approvals: { config, gate },
  });
  return { ...h, gate };
}

/** Engine with approvals off, so the guardrail is the only thing that can
 *  refuse and a DENY is attributable to it. */
function refuseEngine(cfg: {
  blockUnqualifiedDml: boolean;
  blockDdl: boolean;
  blockDml: boolean;
}) {
  return makeEngine({
    tableAccess: WRITABLE,
    rules: [
      parseError(),
      multiStatement(),
      tableAccess(WRITABLE),
      dangerousStatement(cfg),
    ],
  });
}

describe("refuse — the guardrail per class", () => {
  test("block_dml refuses row-scoped writes and nothing else", async () => {
    const { engine } = refuseEngine({
      blockUnqualifiedDml: false,
      blockDdl: false,
      blockDml: true,
    });
    for (const sql of [ROW_CHANGE, INSERT, HIDDEN_ROW_CHANGE]) {
      const d = await engine.handle({ sql, ctx: baseCtx });
      expect(d.allowed).toBe(false);
      expect((d as { reason: string }).reason).toBe("dangerous_statement");
    }
    // Reads are never a write class.
    expect(
      (await engine.handle({ sql: "SELECT 1 FROM orders", ctx: baseCtx }))
        .allowed,
    ).toBe(true);
  });

  test("block_dml refuses writes the dialect emits no site for", async () => {
    // CREATE TABLE / CREATE TABLE AS / SELECT … INTO have no destructive
    // operation to name, so they emit no site — but they materialize data, and
    // the approval stage classifies them as row changes. Refusal has to reach
    // the same set. See the monotonicity test below for why.
    const { engine } = refuseEngine({
      blockUnqualifiedDml: false,
      blockDdl: false,
      blockDml: true,
    });
    for (const sql of [
      CREATE,
      "CREATE TABLE staging AS SELECT * FROM orders",
      "SELECT id, email INTO snapshot FROM orders",
    ]) {
      const d = await engine.handle({ sql, ctx: baseCtx });
      expect(d.allowed).toBe(false);
      expect((d as { reason: string }).reason).toBe("dangerous_statement");
    }
    // Still allowed when the row rule isn't refusing.
    const { engine: permissive } = refuseEngine({
      blockUnqualifiedDml: true,
      blockDdl: true,
      blockDml: false,
    });
    expect((await permissive.handle({ sql: CREATE, ctx: baseCtx })).allowed).toBe(
      true,
    );
  });

  test("MONOTONICITY: Refuse never permits what Ask would have held", async () => {
    // The invariant a three-way control cannot violate. Tightening row changes
    // from Ask to Refuse must never let a statement through that was being held
    // for a human. This regressed once: CREATE TABLE classified as a row change
    // for approvals but emitted no site for refusal, so Ask held it and Refuse
    // ran it unreviewed.
    const held: string[] = [];
    const { engine: asking, gate } = askEngine({ ...NONE, rowChanges: true });
    const { engine: refusing } = refuseEngine({
      blockUnqualifiedDml: false,
      blockDdl: false,
      blockDml: true,
    });
    const corpus = [
      ROW_CHANGE,
      INSERT,
      HIDDEN_ROW_CHANGE,
      CREATE,
      "CREATE TABLE staging AS SELECT * FROM orders",
      "SELECT id INTO snapshot FROM orders",
      "CREATE INDEX idx ON orders (id)",
    ];
    for (const sql of corpus) {
      gate.seen.length = 0;
      await asking.handle({ sql, ctx: baseCtx });
      if (gate.seen.length > 0) held.push(sql);
    }
    // Everything Ask held, Refuse must deny.
    expect(held.length).toBe(corpus.length);
    for (const sql of held) {
      const d = await refusing.handle({ sql, ctx: baseCtx });
      expect(d.allowed).toBe(false);
    }
  });

  test("refusing row changes leaves the other two classes to their own flags", async () => {
    const { engine } = refuseEngine({
      blockUnqualifiedDml: false,
      blockDdl: false,
      blockDml: true,
    });
    expect(
      (await engine.handle({ sql: WHOLE_TABLE, ctx: baseCtx })).allowed,
    ).toBe(true);
    expect((await engine.handle({ sql: SCHEMA, ctx: baseCtx })).allowed).toBe(
      true,
    );
  });

  test("a no-WHERE DELETE is a whole-table write, not a row change", async () => {
    // The two classes must not overlap: refusing row changes while allowing
    // whole-table writes would otherwise be the wrong way round.
    const { engine } = refuseEngine({
      blockUnqualifiedDml: true,
      blockDdl: false,
      blockDml: false,
    });
    expect(
      (await engine.handle({ sql: WHOLE_TABLE, ctx: baseCtx })).allowed,
    ).toBe(false);
    expect((await engine.handle({ sql: ROW_CHANGE, ctx: baseCtx })).allowed).toBe(
      true,
    );
  });
});

describe("ask — the approval stage per class", () => {
  test("holding one class does not hold the others", async () => {
    const { engine, gate } = askEngine({ ...NONE, schemaChanges: true });
    await engine.handle({ sql: ROW_CHANGE, ctx: baseCtx });
    await engine.handle({ sql: WHOLE_TABLE, ctx: baseCtx });
    expect(gate.seen).toHaveLength(0);
    await engine.handle({ sql: SCHEMA, ctx: baseCtx });
    expect(gate.seen).toHaveLength(1);
    expect(gate.seen[0]!.statementType).toBe("DROP");
  });

  test("row changes cover INSERT, qualified UPDATE/DELETE, and CTE-hidden writes", async () => {
    const { engine, gate } = askEngine({ ...NONE, rowChanges: true });
    for (const sql of [ROW_CHANGE, INSERT, HIDDEN_ROW_CHANGE]) {
      await engine.handle({ sql, ctx: baseCtx });
    }
    expect(gate.seen).toHaveLength(3);
    // Not the keyword: this one reports SELECT and deletes rows anyway.
    expect(gate.seen[2]!.statementType).toBe("SELECT");
  });

  test("row changes also cover a write the dialect emits no site for", async () => {
    // CREATE TABLE is a write with no refusable class. It still has to stay
    // inside the stage's reach, or turning on "ask for row changes" would
    // quietly stop holding statements the old single flag held.
    const { engine, gate } = askEngine({ ...NONE, rowChanges: true });
    await engine.handle({ sql: CREATE, ctx: baseCtx });
    expect(gate.seen).toHaveLength(1);
  });

  test("a statement carrying two classes is held if EITHER is held", async () => {
    // A no-WHERE DELETE nested under a row-scoped update: whole-table writes
    // are held, row changes are not. Running it because one of its two classes
    // is unheld would be the worst answer available.
    const sql =
      "WITH d AS (DELETE FROM audit_log RETURNING id) UPDATE orders SET status='x' WHERE id=1";
    const { engine, gate } = askEngine({ ...NONE, wholeTableWrites: true });
    await engine.handle({ sql, ctx: baseCtx });
    expect(gate.seen).toHaveLength(1);
  });

  test("reads are never held, whatever every class says", async () => {
    const { engine, gate } = askEngine({
      rowChanges: true,
      wholeTableWrites: true,
      schemaChanges: true,
    });
    const d = await engine.handle({
      sql: "SELECT count(*) FROM orders",
      ctx: baseCtx,
    });
    expect(d.allowed).toBe(true);
    expect(gate.seen).toHaveLength(0);
  });

  test("all three classes off never consults the gate", async () => {
    const { engine, gate } = askEngine(NONE);
    for (const sql of [ROW_CHANGE, WHOLE_TABLE, SCHEMA, CREATE]) {
      await engine.handle({ sql, ctx: baseCtx });
    }
    expect(gate.seen).toHaveLength(0);
  });
});

describe("refuse outranks ask", () => {
  test("a refused class never reaches a human", async () => {
    // The precedence the UI stops having to explain: a guardrail denies before
    // the approval stage runs, so no approval can buy a way past one and no
    // reviewer is ever shown a statement that was already refused.
    const gate = new StubGate();
    const { engine } = makeEngine({
      tableAccess: WRITABLE,
      rules: [
        parseError(),
        multiStatement(),
        tableAccess(WRITABLE),
        dangerousStatement({
          blockUnqualifiedDml: false,
          blockDdl: true,
          blockDml: false,
        }),
      ],
      approvals: {
        config: { rowChanges: false, wholeTableWrites: false, schemaChanges: true },
        gate,
      },
    });
    const d = await engine.handle({ sql: SCHEMA, ctx: baseCtx });
    expect(d.allowed).toBe(false);
    expect((d as { reason: string }).reason).toBe("dangerous_statement");
    expect(gate.seen).toHaveLength(0);
  });
});
