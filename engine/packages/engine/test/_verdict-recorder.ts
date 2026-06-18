// Verdict-baseline oracle (PR1, commit 1 of the multi-DB Phase-1 plan).
//
// Purpose: pin the engine's policy verdicts byte-for-byte across the
// normalized-IR refactor. The rules are about to stop reading raw
// libpg_query AST and start reading a dialect-produced IR; this is the
// oracle that proves the PG path's behavior did not move.
//
// How it captures the corpus with zero hand-transcription: EVERY engine
// test drives queries through `Engine.handle`, which writes an ATTEMPTED
// event (carrying sql_raw) then a DECIDED event (carrying decision,
// policy_rule, reason/message, statement_type, tables_touched) to its
// audit writer. All engine tests use `MemoryAuditWriter` (test/_helpers.ts),
// so its `write()` is the one universal chokepoint. `_helpers.ts` calls
// `recordDecided()` from there on every DECIDED, pairing it with the
// matching ATTEMPTED's sql (same query_id, same writer instance — robust
// against the deterministic-but-colliding test idGens).
//
// The recorded set is deterministic (the suite is deterministic code), so
// we serialize it sorted by full-record JSON — independent of test
// execution order — and:
//   • MIDPLANE_RECORD_VERDICTS=1 → (re)write the committed baseline.
//   • otherwise, if the baseline exists → diff against it and fail the run
//     (process.exitCode = 1) on any drift. This is the permanent CI gate.
//
// Regenerate intentionally (only for a DELIBERATE, reviewed behavior
// change) with:  MIDPLANE_RECORD_VERDICTS=1 bun test packages/engine

import { afterAll } from "bun:test";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AuditEvent } from "../src/audit/types.ts";

// Sits next to this file: packages/engine/test/.verdicts.baseline.json.
// Broader than the plan's `adversarial/` path on purpose — the MemoryAuditWriter
// chokepoint captures the whole engine corpus (adversarial + strict + engine +
// swap), which makes the oracle stricter.
const BASELINE_PATH = join(import.meta.dir, ".verdicts.baseline.json");
const RECORD = process.env.MIDPLANE_RECORD_VERDICTS === "1";

export interface VerdictRecord {
  sql: string;
  tenant_id: string;
  decision: "ALLOW" | "DENY";
  policy_rule: string | null; // rule name on DENY (DECIDED.payload.policy_rule); null on ALLOW
  message: string | null; // polished sentence on DENY (DECIDED.payload.reason); null on ALLOW
  statement_type: string | null;
  tables_touched: string[]; // ordered — first-encounter walk order; drift here is a real change
}

const records: VerdictRecord[] = [];

// Called from MemoryAuditWriter.write on each DECIDED event. `attemptedSql`
// is the sql_raw from the matching ATTEMPTED event in the same writer.
// Cap the recorded SQL so a single 1 MiB parse-edge query can't bloat the
// committed baseline. The verdict tuple is what we gate on; the SQL is just an
// identifier. Keep the length suffix so two distinct long queries stay
// distinct records.
function capSql(sql: string): string {
  const MAX = 1000;
  return sql.length > MAX ? `${sql.slice(0, MAX)}…[+${sql.length - MAX} chars]` : sql;
}

export function recordDecided(decided: AuditEvent, attemptedSql: string): void {
  if (decided.event_type !== "DECIDED") return;
  const p = decided.payload as Record<string, unknown>;
  records.push({
    sql: capSql(attemptedSql),
    tenant_id: decided.tenant_id,
    decision: p.decision as "ALLOW" | "DENY",
    policy_rule: (p.policy_rule as string | undefined) ?? null,
    message: (p.reason as string | undefined) ?? null,
    statement_type: (p.statement_type as string | undefined) ?? null,
    tables_touched: (p.tables_touched as string[] | undefined) ?? [],
  });
}

// Deterministic serialization: the DISTINCT set of verdict tuples, sorted, so
// the snapshot is independent of test execution order and of how many tests
// happen to exercise the same verdict.
function distinctSorted(): string[] {
  return [...new Set(records.map((r) => JSON.stringify(r)))].sort();
}

let finished = false;
function finish(): void {
  if (finished) return;
  finished = true;
  // No engine verdicts ran in this process (e.g. a non-engine test target) —
  // don't touch the baseline.
  if (records.length === 0) return;

  if (RECORD) {
    const distinct = distinctSorted();
    writeFileSync(BASELINE_PATH, JSON.stringify(distinct, null, 2) + "\n");
    console.error(
      `[verdict-baseline] recorded ${distinct.length} distinct verdicts → ${BASELINE_PATH}`,
    );
    return;
  }

  if (!existsSync(BASELINE_PATH)) return; // not generated yet — nothing to gate against

  // Set semantics: FAIL only on `added` — a verdict tuple produced now that is
  // not in the baseline. That catches every real drift (a changed verdict
  // appears as a new tuple) on ANY run, full or partial, without spuriously
  // failing a single-file run (which legitimately reproduces only a subset, so
  // `missing` is expected and never fails). A genuinely-removed verdict is a
  // deliberate test change, visible in review.
  const baselineSet = new Set(JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as string[]);
  const current = new Set(distinctSorted());
  const added = [...current].filter((x) => !baselineSet.has(x));
  if (added.length === 0) return; // gate passes

  process.exitCode = 1;
  const missing = [...baselineSet].filter((x) => !current.has(x));
  console.error(
    `\n[verdict-baseline] DRIFT — ${added.length} verdict(s) differ from the baseline.\n`,
  );
  console.error(
    `  ++ produced now but NOT in baseline (first ${Math.min(12, added.length)}):\n` +
      added.slice(0, 12).map((x) => "     + " + x).join("\n"),
  );
  if (missing.length) {
    // The pre-change versions of changed verdicts usually show up here.
    console.error(
      `\n  -- baseline tuples not reproduced this run (first ${Math.min(12, missing.length)}; ` +
        `some may just be from tests not run in a partial run):\n` +
        missing.slice(0, 12).map((x) => "     - " + x).join("\n"),
    );
  }
  console.error(
    `\n  If this change is DELIBERATE and reviewed, regenerate with:\n` +
      `    MIDPLANE_RECORD_VERDICTS=1 bun test packages/engine\n`,
  );
}

// Bun's test runner does not emit Node `process` exit events, but a top-level
// `afterAll` registered at module-load time (this module is imported by
// test/_helpers.ts, which every engine test imports) runs as a global
// teardown after the whole suite. The `finished` guard makes it idempotent.
afterAll(finish);
