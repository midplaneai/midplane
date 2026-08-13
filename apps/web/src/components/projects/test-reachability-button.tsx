"use client";

import { useState, useTransition } from "react";

import {
  TestStatus,
  type TestState,
} from "@/components/projects/test-dsn-button";
import { Button } from "@/components/ui/button";

// "Test connection" for a SAVED database — the stored (encrypted) credential,
// not a pasted DSN. The server action decrypts and pings behind the same SSRF
// guard as the pre-submit testers; this component only owns the button states.
// Status rendering is shared with TestDsnButton (TestStatus) so the three ping
// surfaces can't drift.
//
// It sits with the other maintenance actions rather than with the policy
// checks: this asks whether the credential still reaches the database, which is
// a question about the connection and not about what the policy would decide.

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
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="quiet"
        size="inline"
        disabled={test.kind === "pending"}
        onClick={run}
      >
        {test.kind === "pending" ? "Testing…" : "Test connection"}
      </Button>
      <TestStatus state={test} />
    </span>
  );
}
