"use client";

import { useState, useTransition } from "react";

import {
  TestStatus,
  type TestState,
} from "@/components/projects/test-dsn-button";
import { Button } from "@/components/ui/button";

// [Test reachability] for a SAVED database — the stored (encrypted)
// credential, not a pasted DSN. The server action decrypts and pings
// behind the same SSRF guard as the pre-submit testers; this component
// only owns the button states. Status rendering is shared with
// TestDsnButton (TestStatus) so the three ping surfaces can't drift.

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
      <TestStatus state={test} />
    </div>
  );
}
