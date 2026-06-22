"use client";

// Masked preview (design D2 / eng-review E1) — the PROOF surface for masking.
//
// The Test panel (test-policy-panel.tsx) reconciles policy verdicts but never
// executes, so it cannot show a masked value. This panel does: it POSTs a
// read-only SELECT to /api/projects/:id/preview, which runs it through the SAME
// `query` tool the agent uses (execute + maskResultSet), and renders the rows
// the agent would actually receive — masked values and all.
//
// Two outcomes carry the design's weight:
//   - allowed → the agent's-eye rows. The masked cells (***, a hash, last-4)
//     ARE the proof; we badge the columns whose name matches a configured mask.
//   - rejected → when a shape can't be safely masked (view / computed /
//     whole-row / CTE), the engine fails CLOSED and withholds the rows. We
//     render that structured rejection as an EXPLAINED state (reason + hint),
//     not a raw error — that legibility is the point (D2 = A).
//
// Calibrated to DESIGN.md: table-first, lowercase-mono headers (the `Th`
// helper), semantic allow/deny/warn (no fourth color), hairlines, 0-radius,
// and a persistent result-redaction note. Sibling of test-policy-panel.tsx.
//
// Types come from the pure @midplane-cloud/db/policy subpath — never the root
// entrypoint in a client component (see CLAUDE.md).

import { useMemo, useState } from "react";

import { maskRuleLabel, type ColumnMasksConfig } from "@midplane-cloud/db/policy";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type PreviewRow = Record<string, unknown>;

type PanelState =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "rows";
      rows: PreviewRow[];
      rowCount: number | null;
      truncated: boolean;
      rowLimit: number;
    }
  | { kind: "rejected"; policyRule: string; reason: string }
  | { kind: "error"; message: string; retryable: boolean };

interface PreviewResponse {
  allowed?: boolean;
  rows?: PreviewRow[];
  rowCount?: number | null;
  truncated?: boolean;
  rowLimit?: number;
  policyRule?: string;
  reason?: string;
  error?: string;
}

// Engine takes a cold-spawn + handshake + one execution; size the abort over
// the route's own 503/handshake budget (a cold Fly boot can take tens of
// seconds), matching the test panel's posture of not racing a slow-but-fine run.
const CLIENT_TIMEOUT_MS = 90_000;

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="whitespace-nowrap px-3.5 py-2.5 text-left font-mono text-[11.5px] font-normal lowercase tracking-[0.04em] text-subtle">
    {children}
  </th>
);

export function MaskedPreviewPanel({
  projectId,
  database,
  columnMasks,
}: {
  projectId: string;
  database: string;
  /** The selected DB's persisted masks — prefills a sensible query and lets us
   *  badge masked output columns + list what's masked as context. */
  columnMasks: ColumnMasksConfig;
}) {
  const [sql, setSql] = useState(() => defaultPreviewSql(columnMasks));
  const [state, setState] = useState<PanelState>({ kind: "idle" });

  // Lowercased set of every masked column name across the DB (for the header
  // badge) + a flat list of "table.column" for the context line.
  const { maskedNames, maskedRefs } = useMemo(() => {
    const names = new Set<string>();
    const refs: string[] = [];
    for (const [table, cols] of Object.entries(columnMasks)) {
      for (const [col, rule] of Object.entries(cols)) {
        names.add(col.toLowerCase());
        refs.push(`${table}.${col} · ${maskRuleLabel(rule)}`);
      }
    }
    return { maskedNames: names, maskedRefs: refs.sort() };
  }, [columnMasks]);

  const running = state.kind === "running";

  async function run() {
    if (running) return;
    const statement = sql.trim();
    if (statement.length === 0) {
      setState({
        kind: "error",
        message: "Enter a SELECT statement to preview.",
        retryable: false,
      });
      return;
    }
    setState({ kind: "running" });

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/projects/${projectId}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ database, sql: statement }),
        signal: ctl.signal,
      });
      const body = (await res.json().catch(() => ({}))) as PreviewResponse;

      if (res.ok && body.allowed === true) {
        setState({
          kind: "rows",
          rows: Array.isArray(body.rows) ? body.rows : [],
          rowCount: typeof body.rowCount === "number" ? body.rowCount : null,
          truncated: body.truncated === true,
          rowLimit: typeof body.rowLimit === "number" ? body.rowLimit : 0,
        });
        return;
      }
      if (res.ok && body.allowed === false) {
        setState({
          kind: "rejected",
          policyRule: body.policyRule ?? "unknown",
          reason: body.reason ?? "The engine denied this query.",
        });
        return;
      }
      if (res.status === 503) {
        setState({
          kind: "error",
          message: "engine could not start — try again in a moment",
          retryable: true,
        });
        return;
      }
      if (res.status === 429) {
        setState({
          kind: "error",
          message: body.error ?? "too many preview runs — try again shortly",
          retryable: true,
        });
        return;
      }
      setState({
        kind: "error",
        message: body.error ?? `request failed (HTTP ${res.status})`,
        retryable: false,
      });
    } catch {
      setState({
        kind: "error",
        message: ctl.signal.aborted
          ? "engine timed out — try again in a moment"
          : "request failed — check your network and try again",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-6"
      data-testid="masked-preview-panel"
    >
      <div className="space-y-1">
        <h2 className="text-base font-medium text-foreground">Masked preview</h2>
        <p className="text-xs text-muted-foreground">
          Run a read-only{" "}
          <code className="font-mono text-foreground">SELECT</code> through the{" "}
          <strong className="font-medium text-foreground">
            same engine your agent queries
          </strong>{" "}
          and see exactly what it gets back. This executes against your
          database.
        </p>
      </div>

      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        rows={3}
        spellCheck={false}
        placeholder="select email from users limit 10"
        aria-label="SQL to preview"
        disabled={running}
        className="w-full rounded-none border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-[hsl(var(--placeholder))] focus:outline-none focus:ring-1 focus:ring-ring"
      />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={running}
          onClick={() => void run()}
          className="min-h-[44px] sm:min-h-0"
        >
          {running ? "Running…" : "Run preview"}
        </Button>
        {running ? (
          <span className="text-xs text-muted-foreground" role="status">
            running against your data — a cold start can take a few seconds
          </span>
        ) : null}
      </div>

      {state.kind === "error" ? (
        <div className="flex flex-wrap items-center gap-2 border border-[hsl(var(--deny)/0.4)] bg-[hsl(var(--deny)/0.08)] px-3 py-2">
          <span className="text-xs text-[hsl(var(--deny))]">✗ {state.message}</span>
          {state.retryable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void run()}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}

      {state.kind === "rejected" ? (
        <RejectState policyRule={state.policyRule} reason={state.reason} />
      ) : null}

      {state.kind === "rows" ? (
        <RowsResult state={state} maskedNames={maskedNames} />
      ) : null}

      {maskedRefs.length > 0 ? (
        <p className="font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
          masked in this database: {maskedRefs.join(" · ")}
        </p>
      ) : null}

      <p className="rounded-lg border border-border border-l-2 border-l-[hsl(var(--warn))] bg-card px-3.5 py-2.5 text-xs text-muted-foreground">
        <strong className="font-medium text-foreground">Heads up:</strong> masking
        changes what the agent <em>reads back</em>. It can&apos;t hide a value the
        agent filters or sorts on (<span className="font-mono">where email = …</span>
        ). This is result redaction, not a hard guarantee.
      </p>
    </section>
  );
}

// The fail-closed rejection. column_masking is the design's centerpiece: the
// engine ran the query but WITHHELD the rows because the shape (view / computed
// / whole-row / CTE) can't be proven safe to mask. Render it as an explained
// state — the reason already carries the "select the column directly" hint —
// styled warn (a guardrail caught something), not deny (a hard block) and not a
// raw error. Other policy denials render honestly as a denial.
function RejectState({
  policyRule,
  reason,
}: {
  policyRule: string;
  reason: string;
}) {
  const isMasking = policyRule === "column_masking";
  return (
    <div
      className={
        isMasking
          ? "space-y-1.5 border border-[hsl(var(--warn)/0.4)] border-l-2 border-l-[hsl(var(--warn))] bg-[hsl(var(--warn)/0.06)] px-3.5 py-3"
          : "space-y-1.5 border border-[hsl(var(--deny)/0.4)] bg-[hsl(var(--deny)/0.06)] px-3.5 py-3"
      }
      role="status"
      data-testid="preview-rejected"
    >
      <div className="flex items-center gap-2">
        <span
          className={
            isMasking
              ? "text-sm font-medium text-[hsl(var(--warn))]"
              : "text-sm font-medium text-[hsl(var(--deny))]"
          }
        >
          {isMasking
            ? "Rows withheld — this shape can’t be safely masked"
            : "Denied by policy"}
        </span>
        <Badge variant={isMasking ? "warn" : "deny"}>{policyRule}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{reason}</p>
      {isMasking ? (
        <p className="text-xs text-muted-foreground">
          The engine{" "}
          <strong className="font-medium text-foreground">failed closed</strong>:
          rather than risk leaking a masked value through a shape it can&apos;t
          trace, it returned nothing. Your agent sees this same explanation.
        </p>
      ) : null}
    </div>
  );
}

function RowsResult({
  state,
  maskedNames,
}: {
  state: Extract<PanelState, { kind: "rows" }>;
  maskedNames: Set<string>;
}) {
  const { rows, rowCount, truncated, rowLimit } = state;
  // Column order from first-seen keys across the returned rows (node-pg rows are
  // uniform, but union defensively so a ragged row can't drop a column).
  const columns = useMemo(() => {
    const seen: string[] = [];
    const set = new Set<string>();
    for (const row of rows) {
      for (const k of Object.keys(row)) {
        if (!set.has(k)) {
          set.add(k);
          seen.push(k);
        }
      }
    }
    return seen;
  }, [rows]);

  return (
    <div className="space-y-2" data-testid="preview-rows">
      <div
        className="flex flex-wrap items-baseline gap-2 border border-[hsl(var(--allow)/0.4)] bg-[hsl(var(--allow)/0.08)] px-3 py-2"
        role="status"
      >
        <span className="text-sm font-medium text-[hsl(var(--allow))]">
          ✓ this is what your agent receives
        </span>
        <span className="text-xs text-muted-foreground">
          {rows.length === 0
            ? "no rows returned"
            : `${rows.length} ${rows.length === 1 ? "row" : "rows"}${truncated ? ` (first ${rowLimit})` : ""}${
                rowCount !== null && rowCount !== rows.length
                  ? ` · ${rowCount} affected`
                  : ""
              }`}
        </span>
      </div>

      {rows.length > 0 && columns.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border bg-background">
          <table className="w-full border-collapse [font-feature-settings:'tnum']">
            <thead>
              <tr className="border-b border-border">
                {columns.map((c) => (
                  <Th key={c}>
                    <span className="inline-flex items-center gap-1.5">
                      {c}
                      {maskedNames.has(c.toLowerCase()) ? (
                        <Badge variant="allow" withDot>
                          masked
                        </Badge>
                      ) : null}
                    </span>
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-card last:border-b-0">
                  {columns.map((c) => (
                    <td
                      key={c}
                      className="whitespace-nowrap px-3.5 py-2.5 font-mono text-xs text-foreground"
                    >
                      {renderCell(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// Render one cell value as the agent would see it (post-masking). null/undefined
// read as a subtle "null" (v1 masking leaves NULL as NULL — documented); objects
// / arrays (e.g. a json column) serialize compactly.
function renderCell(value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-subtle">null</span>;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Prefill a query that demonstrates masking when the DB has masks: select the
// masked columns from the first masked table, capped. Falls back to empty (the
// textarea placeholder hints the shape) when nothing is masked yet.
function defaultPreviewSql(columnMasks: ColumnMasksConfig): string {
  const tables = Object.keys(columnMasks).sort();
  for (const table of tables) {
    const cols = Object.keys(columnMasks[table] ?? {}).sort();
    if (cols.length > 0) {
      return `select ${cols.join(", ")} from ${table} limit 10`;
    }
  }
  return "";
}
