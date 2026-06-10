"use client";

import { useState } from "react";

// Types + probe builder are pure TS from the /policy subpath and
// lib/probe-matrix — never the root @midplane-cloud/db entrypoint in a
// client component (see CLAUDE.md).
import type { TenantScopeConfig } from "@midplane-cloud/db/policy";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  buildProbeMatrix,
  probeLabel,
  type Probe,
} from "@/lib/probe-matrix";

// Policy test panel — the trust surface. One click runs the probe
// matrix (every table × select/insert/update/delete, plus cross-tenant
// selects on scoped tables) through the REAL engine via
// POST /api/connections/:id/dry-run and renders allow/deny + reason.
// Nothing executes; the verdict pipeline stops at the decision step.
//
// State machine:
//
//   idle ──run──► running ──► verdicts
//     ▲             │  └────► error (engine_unavailable → retryable;
//     └── change db ┘          engine_rejected → engine's body verbatim)
//
// Table source: live introspection (tables route, per-db) ∪ policy
// entries — default-deny tables missing from the policy still appear,
// and policy rows for tables that don't exist still get verdicts.
// Introspection soft-fails ({tables:[], error}) degrade to policy-only
// with an inline hint, never a dead panel.
//
// The custom SQL disclosure posts {sql} to the same endpoint — the
// advanced path, collapsed by default (probes-first per the design
// doc's revised P2).

export interface TestPanelDatabase {
  name: string;
  /** Table names already present in the table_access policy. */
  policyTables: string[];
  tenantScope: TenantScopeConfig;
}

interface Verdict {
  probe?: Probe;
  sql?: string;
  decision: "allow" | "deny";
  reason: string;
  matched_rule: string;
}

type RunMode = "probes" | "sql";

type PanelState =
  | { kind: "idle" }
  | { kind: "running"; mode: RunMode }
  | {
      kind: "verdicts";
      verdicts: Verdict[];
      shownTables: number;
      totalTables: number;
      introspectionHint: string | null;
    }
  // mode: which run failed — Retry re-runs THAT mode (a failed SQL
  // check must not silently switch back to the probe matrix).
  | { kind: "error"; message: string; retryable: boolean; mode: RunMode };

const CLIENT_TIMEOUT_MS = 35_000; // server's engine timeout is 30s

export function TestPolicyPanel({
  connectionId,
  databases,
}: {
  connectionId: string;
  databases: TestPanelDatabase[];
}) {
  const [dbName, setDbName] = useState(databases[0]?.name ?? "");
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [sqlOpen, setSqlOpen] = useState(false);
  const [sql, setSql] = useState("");

  const db = databases.find((d) => d.name === dbName) ?? databases[0];
  if (!db) return null;
  const running = state.kind === "running";

  async function postDryRun(body: Record<string, unknown>) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/connections/${connectionId}/dry-run`, {
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
    setState({ kind: "running", mode: "probes" });

    // Table source: live introspection ∪ policy entries. Introspection
    // failure degrades to policy-only with a hint.
    let introspected: string[] = [];
    let introspectionHint: string | null = null;
    try {
      const res = await fetch(
        `/api/connections/${connectionId}/tables?db=${encodeURIComponent(db.name)}`,
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

    const matrix = buildProbeMatrix(
      [...introspected, ...db.policyTables],
      db.tenantScope,
    );
    if (matrix.probes.length === 0) {
      setState({
        kind: "error",
        message:
          "no tables found — add tables to the policy or check the database is reachable",
        retryable: true,
        mode: "probes",
      });
      return;
    }

    const result = await postDryRun({
      database: db.name,
      probes: matrix.probes,
    });
    if (!result.ok) {
      setState({
        kind: "error",
        message: result.message,
        retryable: result.retryable,
        mode: "probes",
      });
      return;
    }
    setState({
      kind: "verdicts",
      verdicts: result.verdicts,
      shownTables: matrix.tables.length,
      totalTables: matrix.totalTables,
      introspectionHint,
    });
  }

  async function checkSql() {
    const statement = sql.trim();
    if (running || !db || statement.length === 0) return;
    setState({ kind: "running", mode: "sql" });
    const result = await postDryRun({ database: db.name, sql: statement });
    if (!result.ok) {
      setState({
        kind: "error",
        message: result.message,
        retryable: result.retryable,
        mode: "sql",
      });
      return;
    }
    setState({
      kind: "verdicts",
      verdicts: result.verdicts,
      shownTables: 0,
      totalTables: 0,
      introspectionHint: null,
    });
  }

  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-6"
      data-testid="test-policy-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-medium text-foreground">
            Test policy
          </h2>
          <p className="text-xs text-muted-foreground">
            Runs every table through the{" "}
            <strong className="font-medium text-foreground">
              same engine that enforces at query time
            </strong>{" "}
            and shows the verdict. Nothing is executed against your data.
          </p>
        </div>
        <div className="flex items-center gap-2">
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
          ) : (
            <span className="font-mono text-xs text-subtle">{db.name}</span>
          )}
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

      {state.kind === "verdicts" ? (
        <div className="space-y-2">
          {state.introspectionHint ? (
            <p className="text-xs text-[hsl(var(--warn))]">
              {state.introspectionHint}
            </p>
          ) : null}
          {state.totalTables > state.shownTables && state.shownTables > 0 ? (
            <p className="text-xs text-muted-foreground">
              showing the first {state.shownTables} of {state.totalTables}{" "}
              tables
            </p>
          ) : null}
          <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
            {state.verdicts.map((v, i) => (
              <li
                key={i}
                className={
                  v.decision === "deny"
                    ? "flex items-center gap-3 bg-[hsl(var(--deny)/0.06)] px-3 py-2"
                    : "flex items-center gap-3 px-3 py-2"
                }
              >
                {/* Reason is the trust-critical payload — visible on
                    every viewport (stacked under the probe label), full
                    text in the title attr. */}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-foreground">
                    {v.probe ? probeLabel(v.probe) : v.sql}
                  </span>
                  <span
                    className="block truncate text-xs text-muted-foreground"
                    title={`${v.reason} (${v.matched_rule})`}
                  >
                    {v.reason}
                  </span>
                </span>
                <Badge variant={v.decision === "allow" ? "allow" : "deny"}>
                  {v.decision === "allow" ? "ALLOW" : "DENY"}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
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
