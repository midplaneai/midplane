"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

// [Test reachability] for a SAVED database — the stored (encrypted)
// credential, not a pasted DSN. The server action decrypts and pings
// behind the same SSRF guard as the pre-submit testers; this component
// only owns the button states. Result resets on the next click.

type TestState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export function TestReachabilityButton({
  action,
}: {
  action: () => Promise<{ ok: boolean; error?: string }>;
}) {
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [, startTransition] = useTransition();

  function run() {
    setTest({ kind: "pending" });
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          setTest({ kind: "ok" });
        } else {
          setTest({
            kind: "error",
            message: result.error ?? "test failed",
          });
        }
      } catch (e) {
        setTest({
          kind: "error",
          message: e instanceof Error ? e.message : "test failed",
        });
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={test.kind === "pending"}
        onClick={run}
      >
        {test.kind === "pending" ? "Testing…" : "Test reachability"}
      </Button>
      {test.kind === "ok" ? (
        <span className="text-xs font-medium text-[hsl(var(--allow))]">
          ✓ reachable
        </span>
      ) : null}
      {test.kind === "error" ? (
        <span className="text-xs text-destructive" title={test.message}>
          ✗ {test.message}
        </span>
      ) : null}
    </div>
  );
}
