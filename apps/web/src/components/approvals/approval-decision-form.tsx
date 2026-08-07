"use client";

// Approve / deny controls for one held write.
//
// useActionState rather than a bare <form action={…}>: every failure here is a
// race a normal user can lose — someone else decided it, or the window closed
// while the page sat open — and those must render inline, not as a Next runtime
// error overlay. See AGENTS.md, "Server actions: return state, don't throw".

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { decideAction, type DecideState } from "@/app/(app)/approvals/actions";

export function ApprovalDecisionForm({
  id,
  redirectTo,
}: {
  id: string;
  /** Where to go after a decision. The detail page sends the approver back to
   *  the queue; the list page stays put and just revalidates. */
  redirectTo?: string;
}) {
  const [state, formAction, pending] = useActionState<DecideState, FormData>(
    decideAction,
    {},
  );

  return (
    <form action={formAction} className="mt-3 space-y-2">
      <input type="hidden" name="id" value={id} />
      {redirectTo ? (
        <input type="hidden" name="redirectTo" value={redirectTo} />
      ) : null}
      <Input
        name="note"
        placeholder="Note (optional) — shown to the agent and recorded with the decision"
        maxLength={500}
        disabled={pending}
        className="text-xs"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          name="decision"
          value="approved"
          size="sm"
          disabled={pending}
        >
          {pending ? "Saving…" : "Approve — run once"}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="denied"
          size="sm"
          variant="destructive"
          disabled={pending}
        >
          Deny
        </Button>
        <span className="text-[11px] text-subtle">
          Approves this exact statement. A rewrite asks again.
        </span>
      </div>

      {state.error ? (
        <p className="text-xs text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Compact approve/deny for a table row.
 *
 *  No note field: a row is for triage, and a text input per row would double
 *  the table's height for something most decisions do not use. Anyone who wants
 *  to explain themselves clicks through to the request, where the note lives.
 *  Same action, same server-side role check. */
export function QuickDecideForm({ id }: { id: string }) {
  const [state, formAction, pending] = useActionState<DecideState, FormData>(
    decideAction,
    {},
  );

  return (
    <form action={formAction} className="flex items-center justify-end gap-1.5">
      <input type="hidden" name="id" value={id} />
      <Button
        type="submit"
        name="decision"
        value="approved"
        size="sm"
        variant="secondary"
        disabled={pending}
      >
        {pending ? "…" : "Approve"}
      </Button>
      <Button
        type="submit"
        name="decision"
        value="denied"
        size="sm"
        variant="ghost"
        disabled={pending}
        className="text-destructive hover:text-destructive"
      >
        Deny
      </Button>
      {state.error ? (
        <span className="sr-only" role="alert">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
