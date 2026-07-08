"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { StatusDot } from "@/components/dashboard/status-dot";
import { formatRelative } from "@/lib/format";
import {
  AUDIT_HEALTH_COLORS,
  AUDIT_HEALTH_LABELS,
  resolveAuditHealth,
  resolveServing,
  SERVING_COLORS,
  SERVING_LABELS,
  SERVING_REASON_LABELS,
  type ServingState,
} from "@/lib/freshness";
import { cn } from "@/lib/utils";

// The "Hosted MCP server" status, as an interactive popover. The dot + label
// is the trigger; the popover explains what the state means, shows the demoted
// audit-log line, and — for a ready project an owner can manage — offers a
// "Test connection" that wakes the engine and confirms it answers. This is the
// click-to-understand + manual-wake affordance for a status that used to be a
// dead-end red "Down".

// Cold-starting a Fly machine (or a local container) can take a while — give
// the wake+verify round-trip generous headroom before the client gives up.
const CLIENT_TIMEOUT_MS = 30_000;

const EXPLANATION: Record<ServingState, string> = {
  ready:
    "This project will serve MCP queries. The engine starts on demand — it wakes on the next query and idles out after inactivity. Idle is normal and costs nothing.",
  paused: "An owner paused this project. Queries are rejected until it's resumed.",
  broken: "There's nothing for the engine to serve yet. Connect a database to start.",
};

export function ServingStatus({
  projectId,
  pausedAt,
  databaseCount,
  cursor,
  testDatabase,
  canManage,
  labelClassName,
}: {
  projectId: string;
  pausedAt: Date | null;
  databaseCount: number;
  cursor: { lastIndexedAt: Date | null; lastErrorAt: Date | null };
  /** A database name to wake+verify. null hides the Test connection action. */
  testDatabase: string | null;
  canManage: boolean;
  /** Typography for the visible trigger label, so the rail and (future)
   *  dashboard pill can match their surroundings. */
  labelClassName?: string;
}) {
  const { state, reason } = resolveServing({ pausedAt, databaseCount });
  const audit = resolveAuditHealth(cursor);

  // "As of" timestamp — when the audit log last synced successfully. For a
  // delayed log it doubles as how far behind we are; idle has none. (Not the
  // error time: the indexer re-stamps that to ~now on every failed poll, so it
  // would read "just now" while the log is actually minutes behind.)
  const auditDetail = cursor.lastIndexedAt
    ? formatRelative(cursor.lastIndexedAt)
    : null;

  // Testing wakes a real engine, so it's only offered where it's meaningful:
  // a ready project (not paused, has a database) that this user can manage.
  const showTest = canManage && state === "ready" && testDatabase != null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="group inline-flex items-center gap-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          aria-label={`Project status: ${SERVING_LABELS[state]}. Open status details.`}
        >
          <StatusDot
            colorClass={SERVING_COLORS[state]}
            pulse={state === "ready"}
            label={SERVING_LABELS[state]}
          />
          <span
            className={cn(
              "transition-colors group-hover:text-foreground",
              labelClassName ?? "text-xs text-muted-foreground",
            )}
          >
            {SERVING_LABELS[state]}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-3 p-3.5">
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <StatusDot
              colorClass={SERVING_COLORS[state]}
              pulse={state === "ready"}
              label=""
            />
            <span className="text-sm font-medium text-foreground">
              {SERVING_LABELS[state]}
            </span>
            <span className="ml-auto text-[11px] uppercase tracking-wide text-subtle">
              Hosted MCP server
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {state === "broken" && reason
              ? `${SERVING_REASON_LABELS[reason]}. ${EXPLANATION.broken}`
              : EXPLANATION[state]}
          </p>
        </div>

        {showTest && (
          <TestConnectionButton projectId={projectId} database={testDatabase} />
        )}

        <div className="border-t border-border pt-2.5">
          <div className="flex items-center gap-1.5">
            <StatusDot colorClass={AUDIT_HEALTH_COLORS[audit]} label="" />
            <span className="text-xs text-muted-foreground">
              {AUDIT_HEALTH_LABELS[audit]}
            </span>
            {auditDetail && (
              <span className="ml-auto text-[11px] text-subtle">
                {auditDetail}
              </span>
            )}
          </div>
          {audit === "error" && (
            <p className="mt-1 text-[11px] leading-relaxed text-subtle">
              The last sync didn&apos;t finish, so recent activity may not
              appear in the audit log yet. Your queries and policy enforcement
              are unaffected — it retries automatically the next time the engine
              runs{showTest ? ", or use Test connection to retry now." : "."}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; ok: boolean; message: string };

function TestConnectionButton({
  projectId,
  database,
}: {
  projectId: string;
  database: string;
}) {
  const [state, setState] = useState<TestState>({ kind: "idle" });
  const running = state.kind === "running";

  async function run() {
    if (running) return;
    setState({ kind: "running" });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);
    try {
      // A synthetic, non-executing statement: the engine parses it and
      // returns a policy verdict without touching the customer DB. A 200
      // proves the full serve path — spawn/wake, policy push, engine answer.
      const res = await fetch(`/api/projects/${projectId}/dry-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ database, sql: "SELECT 1" }),
        signal: ctl.signal,
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      if (res.ok) {
        setState({
          kind: "done",
          ok: true,
          message: "Engine responded — serving normally.",
        });
      } else if (res.status === 429) {
        setState({
          kind: "done",
          ok: false,
          message: payload.error ?? "Too many tests — try again shortly.",
        });
      } else if (res.status === 503) {
        setState({
          kind: "done",
          ok: false,
          message: payload.detail
            ? `Engine unavailable: ${payload.detail}.`
            : "Engine couldn't start — try again in a moment.",
        });
      } else {
        setState({
          kind: "done",
          ok: false,
          message:
            payload.detail || payload.error || `Failed (HTTP ${res.status}).`,
        });
      }
    } catch {
      setState({
        kind: "done",
        ok: false,
        message: ctl.signal.aborted
          ? "Timed out waking the engine — try again."
          : "Request failed — check your network and try again.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={run}
        disabled={running}
      >
        {running ? "Waking the engine…" : "Test connection"}
      </Button>
      {state.kind === "done" && (
        <p
          className={cn(
            "text-[11px] leading-relaxed",
            state.ok ? "text-[hsl(var(--allow))]" : "text-[hsl(var(--deny))]",
          )}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
