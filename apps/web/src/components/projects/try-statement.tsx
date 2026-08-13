"use client";

// "Try a statement" — one statement, one verdict from the engine that enforces
// at query time. Nothing runs against your data.
//
// This is what's left of the Test card, and deliberately so. The card also ran
// a probe matrix and reconciled it against a cloud-side model of the policy —
// but that model was a SECOND implementation of table-access semantics, so a
// disagreement never told you which of the two was wrong. A tool whose baseline
// reimplements the thing it checks eventually cries wolf.
//
// This asks the engine and reports what it said. There is nothing to disagree
// with, and it answers the question people actually arrive with: why did my
// agent get denied?

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

interface Verdict {
  sql?: string;
  decision: "allow" | "deny";
  reason: string;
  matched_rule: string;
}

type State =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "result"; verdicts: Verdict[] }
  | { kind: "error"; message: string; retryable: boolean };

// Covers the server's worst case from its own budgets: a cold Fly boot
// (spawner bootTimeoutMs 60s) + policy push + one /admin/dry-run call with a
// 30s server timeout, plus overhead. A shorter client abort would give up on a
// request that was about to succeed.
const CLIENT_TIMEOUT_MS = 120_000;

export function TryStatement({
  projectId,
  database,
}: {
  projectId: string;
  database: string;
}) {
  const [open, setOpen] = useState(false);
  const [sql, setSql] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });

  const running = state.kind === "running";

  async function check() {
    const statement = sql.trim();
    if (running || statement.length === 0) return;
    setState({ kind: "running" });

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CLIENT_TIMEOUT_MS);
    try {
      const res = await fetch(`/api/projects/${projectId}/dry-run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ database, sql: statement }),
        signal: ctl.signal,
      });
      const payload = (await res.json()) as {
        verdicts?: Verdict[];
        error?: string;
        detail?: string;
      };
      if (res.ok && Array.isArray(payload.verdicts)) {
        setState({ kind: "result", verdicts: payload.verdicts });
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
          message: payload.error ?? "too many checks — try again shortly",
          retryable: true,
        });
        return;
      }
      setState({
        kind: "error",
        message: payload.detail || payload.error || `HTTP ${res.status}`,
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
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
      >
        Try a statement
      </button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Try a statement</SheetTitle>
            <SheetDescription>
              Runs one statement through the same engine that enforces at query
              time and reports what it decided. Nothing runs against your data.
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="space-y-4">
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={4}
              placeholder={`select sum(total) from orders where created_at > now() - interval '1 day'`}
              aria-label="SQL statement to check"
              disabled={running}
              className="w-full rounded-none border border-input bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-[hsl(var(--placeholder))] focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <Button
              type="button"
              size="sm"
              disabled={running || sql.trim().length === 0}
              onClick={() => void check()}
            >
              {running ? "Checking…" : "Check statement"}
            </Button>

            {running ? (
              <p className="text-xs text-muted-foreground" role="status">
                starting the engine if needed — a cold start can take a few
                seconds
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
                    onClick={() => void check()}
                  >
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}

            {state.kind === "result" ? (
              <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-background">
                {state.verdicts.map((v, i) => (
                  <li
                    key={i}
                    className={
                      v.decision === "allow"
                        ? "flex items-center gap-3 px-3 py-2"
                        : "flex items-center gap-3 bg-[hsl(var(--deny)/0.06)] px-3 py-2"
                    }
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs text-foreground">
                        {v.sql ?? sql.trim()}
                      </span>
                      <span
                        className="block text-xs text-muted-foreground"
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
            ) : null}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}
