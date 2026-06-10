"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

// Pre-submit [Test connection] button shared by the new-connection form
// and the add-database form. Reads the `dsn` field from its enclosing
// <form> (both forms name the input "dsn"), POSTs it to the given
// endpoint, and renders the result inline. Parents reset the status on
// input edits by bumping their `key` — a stale "✓ reachable" next to an
// edited DSN would be a small lie.
//
// Endpoints differ per surface (raw /api/connections/test-dsn before a
// connection exists; /api/connections/:id/databases/test under a
// parent) but share the response shape {ok, error?} and the same
// SSRF-guarded ping underneath.

type TestState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

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
    const dsn = fd.get("dsn");
    if (typeof dsn !== "string" || dsn.length === 0) {
      setTest({
        kind: "error",
        message: "Paste a connection string before testing.",
      });
      return;
    }
    setTest({ kind: "pending" });
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dsn }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) {
        setTest({ kind: "ok" });
      } else {
        setTest({
          kind: "error",
          message: body.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (e) {
      setTest({
        kind: "error",
        message: e instanceof Error ? e.message : "test failed",
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

function TestStatus({ state }: { state: TestState }) {
  if (state.kind === "idle" || state.kind === "pending") return null;
  if (state.kind === "ok") {
    return (
      <span className="text-xs font-medium text-[hsl(var(--allow))]">
        ✓ reachable
      </span>
    );
  }
  return (
    <span className="text-xs text-destructive" title={state.message}>
      ✗ {state.message}
    </span>
  );
}
