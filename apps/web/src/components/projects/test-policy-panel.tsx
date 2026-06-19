"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Types + probe builder are pure TS from the /policy subpath and
// lib/probe-matrix — never the root @midplane-cloud/db entrypoint in a
// client component (see CLAUDE.md).
import type {
  AccessLevel,
  GuardrailsConfig,
  TableAccessPolicy,
  TenantScopeConfig,
} from "@midplane-cloud/db/policy";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildGuardrailProbes,
  buildProbeMatrix,
  expectedDecision,
  pickGuardrailTable,
  probeLabel,
  reconcileGuardrails,
  type Probe,
  type ReconciledGuardrail,
} from "@/lib/probe-matrix";

// Policy test panel — the trust surface. Now that the editor matrix shows
// the policy itself, listing every table×action verdict would just
// re-state it. So this is a RECONCILIATION, not a dump: it runs the probe
// matrix through the REAL engine (POST /api/projects/:id/dry-run) and
// compares each live verdict to what the policy-as-configured should
// decide. The headline is a single pass/fail; only the parts the matrix
// can't show get rows — mismatches (a policy that didn't reach the engine,
// a parse surprise), the cross-tenant denies (the tenant guarantee), and a
// risk callout when the default itself is writable. The full per-check
// list stays available, collapsed. Nothing executes against the data.
//
// State machine:
//
//   idle ──run──► running ──► probe-result / sql-result
//     ▲             │  └────► error (engine_unavailable → retryable;
//     └── change db ┘          engine_rejected → engine's body verbatim)
//
// Table source: live introspection (tables route, per-db) ∪ policy
// entries — default-deny tables missing from the policy still appear,
// and policy rows for tables that don't exist still get verdicts.
// Introspection soft-fails ({tables:[], error}) degrade to policy-only
// with an inline hint, never a dead panel.

export interface TestPanelDatabase {
  name: string;
  /** Full table_access policy — levels drive the expected verdicts the
   *  engine's live answer is reconciled against. */
  policy: TableAccessPolicy;
  tenantScope: TenantScopeConfig;
  /** Dangerous-statement guardrails. Flags that are ON get a literal
   *  dangerous-SQL probe (expected deny) riding along with the matrix. */
  guardrails: GuardrailsConfig;
}

interface Verdict {
  probe?: Probe;
  sql?: string;
  decision: "allow" | "deny";
  reason: string;
  matched_rule: string;
}

/** A probe verdict joined to what the policy-as-configured should decide. */
interface ReconciledProbe {
  probe: Probe;
  expected: "allow" | "deny";
  actual: "allow" | "deny";
  match: boolean;
  reason: string;
  matched_rule: string;
}

// ReconciledGuardrail comes from lib/probe-matrix — the zip is pure and
// unit-tested there (missing verdicts reconcile to failed checks; a deny
// caught by an earlier rule doesn't get credited to the guardrail).

type RunMode = "probes" | "sql";

type PanelState =
  | { kind: "idle" }
  | { kind: "running"; mode: RunMode }
  | {
      kind: "probe-result";
      reconciled: ReconciledProbe[];
      guardrails: ReconciledGuardrail[];
      shownTables: number;
      totalTables: number;
      unlistedCount: number;
      defaultLevel: AccessLevel;
      introspectionHint: string | null;
    }
  | { kind: "sql-result"; verdicts: Verdict[] }
  // mode: which run failed — Retry re-runs THAT mode (a failed SQL
  // check must not silently switch back to the probe matrix).
  | { kind: "error"; message: string; retryable: boolean; mode: RunMode };

// Covers the server's true worst case, derived from its own budgets: a
// cold Fly boot (spawner bootTimeoutMs 60s) + policy push + a SEQUENCE
// of up to six /admin/dry-run calls, each with its own 30s server
// timeout (60 + 6×30 = 240s), plus overhead. A shorter client abort
// burned a probe slot on requests that were about to succeed (review
// finding, twice now) — if the server budgets change, re-derive this.
const CLIENT_TIMEOUT_MS = 250_000;

export function TestPolicyPanel({
  projectId,
  databases,
  reachabilitySlot,
}: {
  projectId: string;
  databases: TestPanelDatabase[];
  /** Optional connectivity check (SELECT 1 on the stored credential),
   *  folded into this card so "is it reachable" and "what would the policy
   *  decide" are one Test surface instead of two adjacent boxes. */
  reachabilitySlot?: ReactNode;
}) {
  const [dbName, setDbName] = useState(databases[0]?.name ?? "");
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sql, setSql] = useState("");

  const db = databases.find((d) => d.name === dbName) ?? databases[0];

  // A result is only meaningful against the config it ran under. After a
  // save (permission grid / tenant scope / guardrails) the page
  // revalidates and this prop changes — drop the old verdicts instead of
  // leaving a stale "✓ engine enforces your policy" next to the control
  // that just invalidated it. The run token also invalidates results from
  // a run that was IN FLIGHT when the config changed: its setState lands
  // after the reset and would otherwise resurrect the stale verdicts.
  const configFingerprint = JSON.stringify(
    db ? { p: db.policy, t: db.tenantScope, g: db.guardrails } : null,
  );
  const runTokenRef = useRef(0);
  useEffect(() => {
    runTokenRef.current += 1;
    setState((s) => (s.kind === "idle" ? s : { kind: "idle" }));
  }, [configFingerprint]);

  if (!db) return null;
  const running = state.kind === "running";

  async function postDryRun(body: Record<string, unknown>) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/projects/${projectId}/dry-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      const payload = (await res.json()) as {
        verdicts?: Verdict[];
        error?: string;
        detail?: string;
      };
      if (res.ok && Array.isArray(payload.verdicts)) {
        return { ok: true as const, verdicts: payload.verdicts };
      }
      if (res.status === 503) {
        return {
          ok: false as const,
          retryable: true,
          message: "engine could not start — try again in a moment",
        };
      }
      if (res.status === 429) {
        return {
          ok: false as const,
          retryable: true,
          message: payload.error ?? "too many probe runs — try again shortly",
        };
      }
      return {
        ok: false as const,
        retryable: false,
        message: payload.detail || payload.error || `HTTP ${res.status}`,
      };
    } catch {
      return {
        ok: false as const,
        retryable: true,
        message: ctl.signal.aborted
          ? "engine timed out — try again in a moment"
          : "request failed — check your network and try again",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runProbes() {
    if (running || !db) return;
    const token = runTokenRef.current;
    const apply = (s: PanelState) => {
      if (runTokenRef.current === token) setState(s);
    };
    setState({ kind: "running", mode: "probes" });

    // Table source: live introspection ∪ policy entries. Introspection
    // failure degrades to policy-only with a hint.
    let introspected: string[] = [];
    let introspectionHint: string | null = null;
    try {
      // limit=250 (route max): the default is the autocomplete's
      // 50-row page — at the probe cap exactly, which made truncation
      // invisible on wide schemas ("showing first 50 of 50").
      const res = await fetch(
        `/api/projects/${projectId}/tables?db=${encodeURIComponent(db.name)}&limit=250`,
        { credentials: "same-origin" },
      );
      const body = (await res.json()) as { tables?: string[]; error?: string };
      if (Array.isArray(body.tables)) introspected = body.tables;
      if (body.error) {
        introspectionHint =
          "couldn't introspect the database — showing policy tables only";
      }
    } catch {
      introspectionHint =
        "couldn't introspect the database — showing policy tables only";
    }

    const policyTables = Object.keys(db.policy.tables);
    const matrix = buildProbeMatrix(
      [...introspected, ...policyTables],
      db.tenantScope,
    );
    if (matrix.probes.length === 0) {
      apply({
        kind: "error",
        message:
          "no tables found — add tables to the policy or check the database is reachable",
        retryable: true,
        mode: "probes",
      });
      return;
    }

    // Guardrail checks ride along as literal dangerous statements (the
    // engine's probe vocabulary can't express them — its DML probes are
    // WHERE-qualified by design). One representative table is enough:
    // guardrails are per-DB, not per-table. Prefer a writable table so
    // the guardrail (not table_access) is what the deny proves. Only ON
    // flags get probes, so every expected verdict is deny.
    const guardrailProbes = buildGuardrailProbes(
      pickGuardrailTable(matrix.tables, db.policy),
      db.guardrails,
    );

    const result = await postDryRun({
      database: db.name,
      probes: matrix.probes,
      ...(guardrailProbes.length > 0
        ? { guardrail_sqls: guardrailProbes.map((g) => g.sql) }
        : {}),
    });
    if (!result.ok) {
      apply({
        kind: "error",
        message: result.message,
        retryable: result.retryable,
        mode: "probes",
      });
      return;
    }

    // Join each live verdict to what the policy-as-configured expects.
    const reconciled: ReconciledProbe[] = result.verdicts
      .filter((v): v is Verdict & { probe: Probe } => Boolean(v.probe))
      .map((v) => {
        const expected = expectedDecision(v.probe, db.policy, db.tenantScope);
        return {
          probe: v.probe,
          expected,
          actual: v.decision,
          match: expected === v.decision,
          reason: v.reason,
          matched_rule: v.matched_rule,
        };
      });
    // Guardrail verdicts come back after the matrix, in guardrail_sqls
    // order (the route fans them out sequentially) — zip by position.
    // reconcileGuardrails fails CLOSED: a probe with no verdict surfaces
    // as a failed check rather than silently vanishing from the headline.
    // `!v.probe` guards the discriminator: if the engine ever echoes the
    // compiled SQL on probe verdicts, matrix rows must not leak into the
    // guardrail zip and misattribute every result after them.
    const sqlVerdicts = result.verdicts.filter(
      (v) => typeof v.sql === "string" && !v.probe,
    );
    const guardrails = reconcileGuardrails(guardrailProbes, sqlVerdicts);
    const listed = new Set(policyTables);
    const unlistedCount = matrix.tables.filter((t) => !listed.has(t)).length;

    apply({
      kind: "probe-result",
      reconciled,
      guardrails,
      shownTables: matrix.tables.length,
      totalTables: matrix.totalTables,
      unlistedCount,
      defaultLevel: db.policy.default,
      introspectionHint,
    });
  }

  async function checkSql() {
    const statement = sql.trim();
    if (running || !db || statement.length === 0) return;
    const token = runTokenRef.current;
    const apply = (s: PanelState) => {
      if (runTokenRef.current === token) setState(s);
    };
    setState({ kind: "running", mode: "sql" });
    const result = await postDryRun({ database: db.name, sql: statement });
    if (!result.ok) {
      apply({
        kind: "error",
        message: result.message,
        retryable: result.retryable,
        mode: "sql",
      });
      return;
    }
    apply({ kind: "sql-result", verdicts: result.verdicts });
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-6"
      data-testid="test-policy-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">Test</h2>
          <p className="text-xs text-muted-foreground">
            Run your policy through the{" "}
            <strong className="font-medium text-foreground">
              same engine that enforces at query time
            </strong>{" "}
            and confirm it decides what you configured. Nothing is executed
            against your data.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {databases.length > 1 ? (
            <select
              value={db.name}
              onChange={(e) => {
                setDbName(e.target.value);
                setState({ kind: "idle" });
              }}
              aria-label="Database to test"
              disabled={running}
              className="h-9 rounded-none border border-input bg-background px-2 font-mono text-xs text-foreground"
            >
              {databases.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : null}
          {reachabilitySlot}
          <Button
            type="button"
            size="sm"
            disabled={running}
            onClick={() => void runProbes()}
          >
            {state.kind === "running" && state.mode === "probes"
              ? "Running…"
              : "Run probes"}
          </Button>
        </div>
      </div>

      {running ? (
        <p className="text-xs text-muted-foreground" role="status">
          starting the engine if needed — a cold start can take a few seconds
        </p>
      ) : null}

      {state.kind === "error" ? (
        <div className="flex flex-wrap items-center gap-2 border border-[hsl(var(--deny)/0.4)] bg-[hsl(var(--deny)/0.08)] px-3 py-2">
          <span className="text-xs text-[hsl(var(--deny))]">
            ✗ {state.message}
          </span>
          {state.retryable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void (state.mode === "sql" ? checkSql() : runProbes())
              }
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {state.kind === "probe-result" ? (
        <ProbeReconciliation state={state} />
      ) : null}

      {state.kind === "sql-result" ? (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
          {state.verdicts.map((v, i) => (
            <ReasonRow
              key={i}
              label={v.sql ?? (v.probe ? probeLabel(v.probe) : "")}
              reason={v.reason}
              matchedRule={v.matched_rule}
              decision={v.decision}
            />
          ))}
        </ul>
      ) : null}

      <details
        open={sqlOpen}
        onToggle={(e) => setSqlOpen((e.target as HTMLDetailsElement).open)}
        className="border-t border-border pt-3"
      >
        <summary className="cursor-pointer list-none font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          ▸ custom sql — check one statement against the policy
        </summary>
        <div className="mt-3 space-y-2">
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={3}
            placeholder={`select sum(total) from orders where created_at > now() - interval '1 day'`}
            aria-label="SQL statement to check"
            disabled={running}
            className="w-full rounded-none border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-[hsl(var(--placeholder))] focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={running || sql.trim().length === 0}
            onClick={() => void checkSql()}
          >
            {state.kind === "running" && state.mode === "sql"
              ? "Checking…"
              : "Check statement"}
          </Button>
        </div>
      </details>
    </section>
  );
}

// The reconciliation view: a pass/fail headline, then only the rows the
// editor matrix can't already show — mismatches, the writable-default
// callout, the cross-tenant guarantees — with the full check list folded
// behind a disclosure.
function ProbeReconciliation({
  state,
}: {
  state: Extract<PanelState, { kind: "probe-result" }>;
}) {
  const { reconciled, shownTables, totalTables, unlistedCount, defaultLevel } =
    state;
  const mismatches = reconciled.filter((r) => !r.match);
  const guarantees = reconciled.filter(
    (r) => r.probe.cross_tenant && r.match && r.actual === "deny",
  );
  const guardrailMisses = state.guardrails.filter((g) => !g.match);
  const guardrailHolds = state.guardrails.filter((g) => g.match);
  const mismatchCount = mismatches.length + guardrailMisses.length;
  const ok = mismatchCount === 0;

  return (
    <div className="space-y-3">
      {state.introspectionHint ? (
        <p className="text-xs text-[hsl(var(--warn))]">
          {state.introspectionHint}
        </p>
      ) : null}

      {/* Headline — the one line that answers "is the engine doing what I
          configured?" */}
      <div
        className={
          ok
            ? "flex items-baseline gap-2 border border-[hsl(var(--allow)/0.4)] bg-[hsl(var(--allow)/0.08)] px-3 py-2"
            : "flex items-baseline gap-2 border border-[hsl(var(--deny)/0.4)] bg-[hsl(var(--deny)/0.08)] px-3 py-2"
        }
        role="status"
        data-testid="reconciliation-headline"
      >
        <span
          className={
            ok
              ? "text-sm font-medium text-[hsl(var(--allow))]"
              : "text-sm font-medium text-[hsl(var(--deny))]"
          }
        >
          {ok
            ? "✓ engine enforces your policy"
            : `✗ ${mismatchCount} ${mismatchCount === 1 ? "mismatch" : "mismatches"} — reality differs from your policy`}
        </span>
        <span className="text-xs text-muted-foreground">
          {shownTables} {shownTables === 1 ? "table" : "tables"} checked
          {totalTables > shownTables ? ` of ${totalTables}` : ""}
        </span>
      </div>

      {/* Mismatches — the bugs. Each shows what the engine actually did
          against what the policy says it should. A guardrail miss is the
          worst kind: a statement the net should have caught came back
          allow. */}
      {mismatchCount > 0 ? (
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-[hsl(var(--deny)/0.4)] bg-background">
          {mismatches.map((r, i) => (
            <li
              key={i}
              className="flex items-center gap-3 bg-[hsl(var(--deny)/0.06)] px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-foreground">
                  {probeLabel(r.probe)}
                </span>
                <span
                  className="block truncate text-xs text-muted-foreground"
                  title={`${r.reason} (${r.matched_rule})`}
                >
                  expected {r.expected} — {r.reason}
                </span>
              </span>
              <Badge variant={r.actual === "allow" ? "allow" : "deny"}>
                {r.actual === "allow" ? "ALLOW" : "DENY"}
              </Badge>
            </li>
          ))}
          {guardrailMisses.map((g, i) => (
            <li
              key={`g-${i}`}
              className="flex items-center gap-3 bg-[hsl(var(--deny)/0.06)] px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs text-foreground">
                  {g.probe.label}
                </span>
                <span
                  className="block truncate text-xs text-muted-foreground"
                  title={
                    g.verdict
                      ? `${g.verdict.reason} (${g.verdict.matched_rule})`
                      : "the engine returned no verdict for this check"
                  }
                >
                  {g.verdict
                    ? `guardrail is on — expected deny — ${g.verdict.reason}`
                    : "guardrail is on — the engine returned no verdict for this check"}
                </span>
              </span>
              <Badge variant={g.verdict?.decision === "allow" ? "allow" : "warn"}>
                {g.verdict?.decision === "allow" ? "ALLOW" : "NO VERDICT"}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Risk callout — a writable default means every table you didn't
          list is writable. The matrix shows the default level; this says
          how many real tables inherit it. */}
      {defaultLevel === "read_write" && unlistedCount > 0 ? (
        <p className="border border-[hsl(var(--warn)/0.4)] bg-[hsl(var(--warn)/0.08)] px-3 py-2 text-xs text-[hsl(var(--warn))]">
          ⚠ {unlistedCount} unlisted{" "}
          {unlistedCount === 1 ? "table is" : "tables are"} writable under your
          default — add overrides to lock them down.
        </p>
      ) : null}

      {/* Guardrail guarantee — like the cross-tenant deny, a categorical
          block isn't expressible in the deny/read/write matrix, so the
          confirmation that the net catches a live dangerous statement is
          always worth showing. */}
      {guardrailHolds.length > 0 ? (
        <ul className="space-y-1">
          {guardrailHolds.map((g, i) => (
            <li
              key={i}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <span className="text-[hsl(var(--allow))]">✓</span>
              <span className="font-mono text-foreground">{g.probe.label}</span>
              {/* Credit the deny honestly: when table_access (or another
                  earlier rule) caught the statement first, the guardrail
                  itself wasn't what decided — don't claim it did. */}
              <span>
                {g.byGuardrail
                  ? "denied by guardrail"
                  : `denied by ${g.verdict?.matched_rule ?? "policy"}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Tenant guarantee — the cross-tenant deny isn't expressible in the
          deny/read/write matrix, so it's always worth showing. */}
      {guarantees.length > 0 ? (
        <ul className="space-y-1">
          {guarantees.map((r, i) => (
            <li
              key={i}
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <span className="text-[hsl(var(--allow))]">✓</span>
              <span className="font-mono text-foreground">{r.probe.table}</span>
              <span>cross-tenant read denied</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Full detail, folded — the curious can still see every check. */}
      <details className="text-xs">
        <summary className="cursor-pointer list-none font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
          ▸ all {reconciled.length + state.guardrails.length} checks
        </summary>
        <ul className="mt-2 divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
          {reconciled.map((r, i) => (
            <ReasonRow
              key={i}
              label={probeLabel(r.probe)}
              reason={r.reason}
              matchedRule={r.matched_rule}
              decision={r.actual}
            />
          ))}
          {state.guardrails.map((g, i) => (
            <ReasonRow
              key={`g-${i}`}
              label={g.probe.label}
              reason={g.verdict?.reason ?? "no verdict returned"}
              matchedRule={g.verdict?.matched_rule ?? "missing"}
              decision={g.verdict?.decision ?? "missing"}
            />
          ))}
        </ul>
      </details>
    </div>
  );
}

// One verdict line: statement/probe label over its reason, with the
// decision badge. Deny rows carry the subtle blush tint (DESIGN.md);
// "missing" (a check the engine returned no verdict for) keeps the
// failure tint but wears the warn NO VERDICT pill — rendering it as a
// DENY would read as a pass in the guardrail rows.
function ReasonRow({
  label,
  reason,
  matchedRule,
  decision,
}: {
  label: string;
  reason: string;
  matchedRule: string;
  decision: "allow" | "deny" | "missing";
}) {
  return (
    <li
      className={
        decision === "allow"
          ? "flex items-center gap-3 px-3 py-2"
          : "flex items-center gap-3 bg-[hsl(var(--deny)/0.06)] px-3 py-2"
      }
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs text-foreground">
          {label}
        </span>
        <span
          className="block truncate text-xs text-muted-foreground"
          title={`${reason} (${matchedRule})`}
        >
          {reason}
        </span>
      </span>
      <Badge
        variant={
          decision === "allow" ? "allow" : decision === "deny" ? "deny" : "warn"
        }
      >
        {decision === "allow"
          ? "ALLOW"
          : decision === "deny"
            ? "DENY"
            : "NO VERDICT"}
      </Badge>
    </li>
  );
}
