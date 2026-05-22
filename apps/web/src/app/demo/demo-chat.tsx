"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ACCESS_LEVELS,
  type AccessLevel,
  type TableAccessPolicy,
} from "@midplane-cloud/db/policy";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { type Decision, evaluate, prettyPrintSql } from "./evaluate";
import {
  type DemoExample,
  EXAMPLES,
  FIXTURE_TABLE_NAMES,
  FIXTURE_TABLES,
  STARTING_POLICY,
  type FixtureRow,
} from "./fixtures";

// The latest attempt's full state. Only ever one at a time; the
// audit log below preserves the trail of prior attempts. Every chip
// click produces a populated Result (intent + sql + decision) — no
// pending/error states since there's no network round-trip.
interface Result {
  prompt: string;
  ts: Date;
  intent: string;
  sql: string;
  decision: Decision;
}

// One entry per action — the real engine emits DECIDED then
// EXECUTED, but the demo collapses those into a single visible row.
// Production ops engineers care about the two-event split (latency
// between decide and execute, partial failures); a landing visitor
// does not.
interface AuditEntry {
  id: number;
  ts: Date;
  statement: string;
  agentName: string;
  decision: "allow" | "deny";
  reason: string;
  table: string | null;
}

// Surface name in the audit log; intentionally generic since the
// real agent identity in production comes from the MCP token's
// `agent_name` claim. In a real product trial the visitor's own
// agent (claude-code, cursor, etc.) would appear here.
const DEMO_AGENT = "demo-agent";

export function DemoChat() {
  const [policy, setPolicy] = useState<TableAccessPolicy>(STARTING_POLICY);
  const [result, setResult] = useState<Result | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const nextAuditId = useRef(1);
  // Snapshot for the run callback so the policy at re-evaluation time
  // is always the current one without invalidating the callback on
  // every keystroke.
  const policyRef = useRef(policy);
  policyRef.current = policy;
  // Same trick for result — the policy-change effect reads the latest
  // result without taking it as a dep (which would cause the effect to
  // re-fire and immediately re-evaluate, an infinite loop).
  const resultRef = useRef(result);
  resultRef.current = result;

  const run = useCallback((ex: DemoExample) => {
    const ts = new Date();
    const decision = evaluate(ex.sql, policyRef.current);
    setResult({
      prompt: ex.prompt,
      ts,
      intent: ex.intent,
      sql: ex.sql,
      decision,
    });

    // Single entry per action. For allows, append the outcome to the
    // policy reason so the visitor sees both "why was this allowed"
    // and "what happened" in one row.
    const outcome =
      decision.decision === "allow"
        ? decision.op === "read"
          ? ` · ${decision.rows?.length ?? 0} row(s) returned`
          : ` · ${decision.rowsAffected ?? 0} row(s) affected`
        : "";
    const entry: AuditEntry = {
      id: nextAuditId.current++,
      ts,
      statement: decision.normalizedSql,
      agentName: DEMO_AGENT,
      decision: decision.decision,
      reason: decision.reason + outcome,
      table: decision.table,
    };
    setAuditLog((a) => [entry, ...a]);
  }, []);

  // Pre-run the first example on mount so the result panel + audit
  // log are populated on first paint — visitors see the loop in
  // motion before they click anything.
  useEffect(() => {
    if (EXAMPLES[0]) run(EXAMPLES[0]);
  }, [run]);

  // Auto re-evaluate the active query whenever the policy changes.
  // This closes the demo loop — flip a level on the right, see the
  // decision flip in place. No new audit entry if the decision text
  // didn't actually change (visitor edited an unrelated row), so the
  // log doesn't get spammed by every level click.
  useEffect(() => {
    const prev = resultRef.current;
    if (!prev) return;
    const next = evaluate(prev.sql, policy);
    if (
      next.decision === prev.decision.decision &&
      next.reason === prev.decision.reason
    ) {
      return;
    }
    const newTs = new Date();
    setResult({ ...prev, ts: newTs, decision: next });
    const outcome =
      next.decision === "allow"
        ? next.op === "read"
          ? ` · ${next.rows?.length ?? 0} row(s) returned`
          : ` · ${next.rowsAffected ?? 0} row(s) affected`
        : "";
    setAuditLog((a) => [
      {
        id: nextAuditId.current++,
        ts: newTs,
        statement: next.normalizedSql,
        agentName: DEMO_AGENT,
        decision: next.decision,
        reason: next.reason + outcome,
        table: next.table,
      },
      ...a,
    ]);
  }, [policy]);

  const reset = () => {
    setPolicy(STARTING_POLICY);
    setResult(null);
    setAuditLog([]);
    nextAuditId.current = 1;
  };

  const tablesInPolicy = useMemo(() => {
    // Union of fixture tables + any policy-declared tables, sorted.
    // This way the editor surfaces every fixture even if the visitor
    // hasn't pinned it, and never hides a table they've added.
    const set = new Set<string>([
      ...FIXTURE_TABLE_NAMES,
      ...Object.keys(policy.tables),
    ]);
    return Array.from(set).sort();
  }, [policy.tables]);

  // One dark surface, no nested cards. Sections are separated by
  // vertical whitespace and a single hairline above the audit row.
  // The input is the only lifted element (its own bg + border) so the
  // eye lands there first. Editorial flow: mono-uppercase section
  // labels match the .sec-num idiom on the surrounding landing.
  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-8 lg:grid-cols-12">
      <div className="flex flex-col gap-4 lg:col-span-7">
        <div className="flex flex-col gap-2">
          <SectionLabel left="Try an example" />
          <p className="text-[12px] text-muted-foreground">
            Click below. Edit the table access on the right. Re-click to
            see the decision flip.
          </p>
          <ExampleChips onPick={run} activePrompt={result?.prompt ?? null} />
        </div>
        {result ? <ResultPanel result={result} /> : null}
        <SignupCta />
      </div>

      <div className="flex flex-col gap-3 lg:col-span-5">
        <SectionLabel
          left="Table access"
          right={
            <button
              onClick={reset}
              className="font-mono text-[10px] uppercase tracking-[0.04em] text-subtle hover:text-foreground"
            >
              Reset
            </button>
          }
        />
        <PolicyEditor
          policy={policy}
          tables={tablesInPolicy}
          onChange={setPolicy}
        />
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-6 lg:col-span-12">
        <SectionLabel
          left="Audit log"
          right={
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.04em] text-subtle">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[hsl(var(--allow))] motion-reduce:animate-none" />
              Live
            </span>
          }
        />
        <AuditTable entries={auditLog} />
      </div>
    </div>
  );
}

function SectionLabel({
  left,
  right,
}: {
  left: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-[10px] uppercase tracking-[0.04em] text-subtle">
        {left}
      </span>
      {right}
    </div>
  );
}

function ExampleChips({
  onPick,
  activePrompt,
}: {
  onPick: (ex: (typeof EXAMPLES)[number]) => void;
  activePrompt: string | null;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {EXAMPLES.map((ex) => {
        const isActive = ex.prompt === activePrompt;
        return (
          <button
            key={ex.label}
            onClick={() => onPick(ex)}
            title={ex.hint}
            className={cn(
              "rounded-[4px] border px-2 py-1 text-[11px] transition-colors",
              isActive
                ? "border-[hsl(var(--ring))] bg-[hsl(var(--bg-3))] text-foreground"
                : "border-border bg-secondary text-muted-foreground hover:border-border-strong hover:text-foreground",
            )}
          >
            {ex.label}
          </button>
        );
      })}
    </div>
  );
}

function ResultPanel({ result }: { result: Result }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted-foreground">
        <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.04em] text-subtle">
          intent
        </span>
        {result.intent}
      </p>
      <pre className="overflow-x-auto rounded-md border border-border bg-[hsl(var(--bg-3))] p-3 font-mono text-[12px] leading-snug text-foreground">
        {prettyPrintSql(result.sql)}
      </pre>
      {/* Keying on result.ts forces a remount on every re-evaluation,
          which re-triggers the one-shot pulse animation so the eye is
          drawn to the change after a policy flip. */}
      <DecisionPane key={result.ts.getTime()} decision={result.decision} />
    </div>
  );
}

function DecisionPane({ decision }: { decision: Decision }) {
  return (
    <div
      className={cn(
        "rounded-md border p-3 text-[13px]",
        "motion-safe:animate-[pulse_900ms_ease-out_1]",
        decision.decision === "allow"
          ? "border-[hsl(var(--allow)/0.25)] bg-[hsl(var(--allow)/0.06)]"
          : "border-[hsl(var(--deny)/0.25)] bg-[hsl(var(--deny)/0.06)]",
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant={decision.decision === "allow" ? "allow" : "deny"}>
          {decision.decision}
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">
          {decision.reason}
        </span>
      </div>
      {decision.decision === "allow" ? (
        decision.op === "read" ? (
          <ResultRows rows={decision.rows ?? []} />
        ) : (
          <p className="font-mono text-[12px] text-muted-foreground">
            {decision.rowsAffected ?? 0} row(s) affected.
          </p>
        )
      ) : (
        <p className="font-mono text-[12px] text-muted-foreground">
          Statement rejected before reaching the database.
        </p>
      )}
    </div>
  );
}

function ResultRows({ rows }: { rows: FixtureRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="font-mono text-[12px] text-muted-foreground">
        0 rows returned.
      </p>
    );
  }
  const cols = Object.keys(rows[0] ?? {});
  // Cells sized to content (`w-max`) so columns aren't squashed by the
  // narrow chat column. Native horizontal scrollbar appears whenever
  // the row is wider than the container.
  return (
    <div className="overflow-x-auto">
      <table className="w-max min-w-full border-collapse font-mono text-[11px]">
        <thead>
          <tr className="border-b border-border">
            {cols.map((c) => (
              <th
                key={c}
                className="px-2 py-1 text-left text-[10px] uppercase tracking-[0.04em] text-subtle"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/60 last:border-0">
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 text-foreground">
                  {r[c] === null ? (
                    <span className="text-subtle">null</span>
                  ) : (
                    String(r[c])
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Post-demo CTA. Sits below the result panel so the visitor encounters
// it after seeing a decision in action, not before — the right moment
// for "want this for real?" is once they've watched the loop work.
// Dashed border + muted bg distinguishes it from the demo's own
// interactive surfaces so nobody mistakes it for an input or chip.
function SignupCta() {
  return (
    <Link
      href="/sign-up"
      className={cn(
        "group flex items-center justify-between gap-3 rounded-md border border-dashed border-border px-4 py-3 text-[13px] transition-colors",
        "hover:border-[hsl(var(--ring))]",
      )}
    >
      <span className="text-muted-foreground group-hover:text-foreground">
        Try this against your own database — point midplane at any
        Postgres, get an MCP endpoint for your agent.
      </span>
      <span className="shrink-0 font-medium text-[hsl(var(--ring))] group-hover:underline">
        Start free →
      </span>
    </Link>
  );
}

function PolicyEditor({
  policy,
  tables,
  onChange,
}: {
  policy: TableAccessPolicy;
  tables: string[];
  onChange: (p: TableAccessPolicy) => void;
}) {
  // Every table in the demo is pre-declared with an explicit level
  // (deny / read / read_write). The OSS engine still has a `default:`
  // fallback; the demo just doesn't surface it. If a SQL statement
  // references a table that's not in the editor (LLM hallucinated a
  // name, for example), the evaluator still falls back to "not in
  // allowlist — denied".
  const setTable = (name: string, level: AccessLevel) => {
    onChange({ ...policy, tables: { ...policy.tables, [name]: level } });
  };

  return (
    <div className="flex flex-col gap-2">
      {tables.map((t) => {
        const level = policy.tables[t] ?? "deny";
        const fixture = FIXTURE_TABLES[t];
        const columns = fixture && fixture[0] ? Object.keys(fixture[0]) : [];
        return (
          <PolicyRow
            key={t}
            label={t}
            level={level}
            columns={columns}
            onChange={(l) => setTable(t, l)}
          />
        );
      })}
    </div>
  );
}

function PolicyRow({
  label,
  level,
  columns,
  onChange,
}: {
  label: string;
  level: AccessLevel;
  columns: string[];
  onChange: (l: AccessLevel) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-mono text-[12px] text-foreground">
          {label}
        </span>
        {columns.length > 0 ? (
          <span
            className="truncate font-mono text-[10px] text-subtle"
            title={columns.join(", ")}
          >
            {columns.join(", ")}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1 pt-0.5">
        {ACCESS_LEVELS.map((lv) => (
          <SegBtn
            key={lv}
            active={level === lv}
            onClick={() => onChange(lv)}
            variant={
              lv === "deny"
                ? "deny"
                : lv === "read_write"
                  ? "allow"
                  : "warn"
            }
          >
            {lv}
          </SegBtn>
        ))}
      </div>
    </div>
  );
}

function SegBtn({
  active,
  onClick,
  children,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  variant: "deny" | "warn" | "allow";
}) {
  const activeClass =
    variant === "deny"
      ? "bg-[hsl(var(--deny)/0.12)] border-[hsl(var(--deny)/0.35)] text-[hsl(var(--deny))]"
      : variant === "allow"
        ? "bg-[hsl(var(--allow)/0.12)] border-[hsl(var(--allow)/0.35)] text-[hsl(var(--allow))]"
        : "bg-[hsl(var(--warn)/0.12)] border-[hsl(var(--warn)/0.35)] text-[hsl(var(--warn))]";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-[4px] border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.04em] transition-colors",
        active
          ? activeClass
          : "border-border bg-secondary text-subtle hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="font-mono text-[11px] text-subtle">
        Awaiting first event.
      </p>
    );
  }
  // Cap visible height at ~5 rows so a long demo session doesn't push
  // the rest of the landing page off-screen; new entries land at the
  // top and the older trail scrolls below.
  return (
    <div className="max-h-[180px] overflow-y-auto overflow-x-auto">
      <table className="w-full border-collapse font-mono text-[11px]">
        <thead className="sticky top-0 bg-background">
          <tr className="border-b border-border">
            <Th>ts</Th>
            <Th>decision</Th>
            <Th>agent</Th>
            <Th>table</Th>
            <Th>statement</Th>
            <Th>reason · outcome</Th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr
              key={e.id}
              className={cn(
                "border-b border-border/60 last:border-0",
                // Pulse the latest row briefly so the "Live" affordance
                // has a referent. CSS-only — no JS timer to clean up.
                i === 0 && "motion-safe:animate-[pulse_1.6s_ease-out_1]",
              )}
            >
              <Td className="text-subtle">{formatTs(e.ts)}</Td>
              <Td>
                <Badge
                  variant={e.decision === "allow" ? "allow" : "deny"}
                  className="!py-0"
                >
                  {e.decision}
                </Badge>
              </Td>
              <Td className="text-muted-foreground">{e.agentName}</Td>
              <Td className="text-muted-foreground">{e.table ?? "—"}</Td>
              <Td className="max-w-[420px] truncate text-foreground">
                {e.statement}
              </Td>
              <Td className="text-muted-foreground">{e.reason}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-2 py-1 text-left text-[10px] uppercase tracking-[0.04em] text-subtle">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={cn("px-2 py-1 align-top", className)}>{children}</td>;
}

function formatTs(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
