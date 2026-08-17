"use client";

import { useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { describeDsnProblem, normalizeDsn } from "@/lib/dsn-format";

// Pre-submit [Test connection] button shared by the new-project form
// and the add-database form. Reads the `dsn` field from its enclosing
// <form> (both forms name the input "dsn"), POSTs it to the given
// endpoint, and renders the result inline. Parents reset the status on
// input edits by bumping their `key` — a stale "✓ reachable" next to an
// edited DSN would be a small lie.
//
// Format problems never leave the browser: describeDsnProblem runs first, so a
// typo answers instantly and doesn't spend a slot in the shared per-customer
// ping budget. The endpoint runs the same check server-side for non-browser
// callers.
//
// Endpoints differ per surface (raw /api/projects/test-dsn before a
// project exists; /api/projects/:id/databases/test under a
// parent) but share the response shape {ok, error?, hint?} and the same
// SSRF-guarded ping underneath.

export type TestState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "error"; title?: string; message: string; hint?: string };

export function TestDsnButton({
  endpoint,
  disabled,
}: {
  endpoint: string;
  disabled?: boolean;
}) {
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  async function run(form: HTMLFormElement) {
    const fd = new FormData(form);
    const raw = fd.get("dsn");
    const problem = describeDsnProblem(raw);
    if (problem) {
      setTest({
        kind: "error",
        title: "Check the connection string",
        message: problem.message,
        hint: problem.hint,
      });
      return;
    }
    // describeDsnProblem returning null guarantees a usable string.
    const dsn = normalizeDsn(String(raw));
    setTest({ kind: "pending" });
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dsn }),
      });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        hint?: string;
      };
      if (res.ok && body.ok) {
        setTest({ kind: "ok" });
      } else {
        setTest({
          kind: "error",
          title: "Couldn't reach the database",
          message: body.error ?? `The test failed (HTTP ${res.status}).`,
          hint: body.hint,
        });
      }
    } catch (e) {
      setTest({
        kind: "error",
        title: "Couldn't reach the database",
        message:
          e instanceof Error
            ? e.message
            : "The test request didn't complete. Check your network and try again.",
      });
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || test.kind === "pending"}
        onClick={(e) => {
          const form = (e.currentTarget as HTMLButtonElement).closest("form");
          if (form) void run(form);
        }}
      >
        {test.kind === "pending" ? "Testing…" : "Test connection"}
      </Button>
      <TestStatus state={test} />
    </>
  );
}

/** Shared by TestDsnButton and TestReachabilityButton — one rendering
 *  of the outcome across all three ping surfaces.
 *
 *  `variant` is about the space available, not the severity. "block" (the
 *  form surfaces) gives a failure its own full-width row under the buttons:
 *  these messages are sentences — a driver's "password authentication failed
 *  for user …", the guard's "Could not connect. Check the host, port, …", a
 *  format problem plus its remedy — and squeezing them into a flex row beside
 *  the button truncated the part that told the user what to do. It relies on
 *  the host being a `flex flex-wrap` row (basis-full then claims a new line).
 *  "inline" stays a small span for the maintenance row on the database page,
 *  where the control is one text link among several. Success is compact in
 *  both: "reachable" needs no elaboration. */
export function TestStatus({
  state,
  variant = "block",
}: {
  state: TestState;
  variant?: "block" | "inline";
}) {
  if (state.kind === "idle" || state.kind === "pending") return null;
  if (state.kind === "ok") {
    return (
      <span className="text-xs font-medium text-[hsl(var(--allow))]">
        ✓ reachable
      </span>
    );
  }
  if (variant === "inline") {
    return (
      <span className="text-xs text-destructive" title={state.message}>
        ✗ {state.message}
      </span>
    );
  }
  return (
    <Alert
      tone="deny"
      className="basis-full"
      title={state.title ? `✗ ${state.title}` : undefined}
      hint={state.hint}
    >
      {state.message}
    </Alert>
  );
}
