"use client";

import { useActionState, useState } from "react";

import { AccessRadio } from "@/components/access-radio";
import { TestDsnButton } from "@/components/connections/test-dsn-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_CONNECTION_NAME_LENGTH } from "@/lib/connection-name";

// Server-action result used by useActionState. On validation failure the
// action returns `{ error }` and the form renders it inline. On success
// the action calls redirect(), which Next handles outside this state
// channel — so a successful submit never resolves to a state object.
//
// `upgradeUrl` is set when the failure is a plan cap (not a validation
// error): the form renders an upgrade link alongside the message so a
// capped user has a one-click path to /billing.
export type NewConnectionFormState = { error?: string; upgradeUrl?: string };

const initialState: NewConnectionFormState = {};

export function NewConnectionForm({
  action,
}: {
  action: (
    prev: NewConnectionFormState,
    formData: FormData,
  ) => Promise<NewConnectionFormState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  // Remount key for TestDsnButton — editing the DSN clears a stale
  // "✓ reachable".
  const [testVersion, setTestVersion] = useState(0);

  return (
    <form action={formAction} className="space-y-6" noValidate>
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          type="text"
          maxLength={MAX_CONNECTION_NAME_LENGTH}
          placeholder="Production read-replica"
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">
          A short label to tell this connection apart from others.{" "}
          <strong className="font-medium text-foreground">Optional.</strong>
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="dsn">DATABASE_URL</Label>
        <Input
          id="dsn"
          name="dsn"
          type="text"
          required
          placeholder="postgres://readonly_agent:pass@host:5432/db?sslmode=require"
          className="font-mono"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "new-connection-error" : undefined}
          disabled={pending}
          onChange={() => setTestVersion((v) => v + 1)}
        />
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Best practice:</strong>{" "}
          a least-privilege role. Midplane enforces the access level you pick
          below; defense-in-depth at the DB layer still matters.
        </p>
      </div>
      <fieldset className="space-y-3" disabled={pending}>
        <legend className="font-mono text-[11.5px] font-medium lowercase tracking-[0.04em] text-foreground">
          Default agent access
        </legend>
        <p className="text-xs text-muted-foreground">
          Sets the baseline for any table the agent queries. Per-table overrides
          can be added later from the connection page.
        </p>
        <div className="space-y-2">
          <AccessRadio
            value="read"
            label="Read"
            description={
              <>
                Agents can query any table. Writes always denied unless granted
                per-table.{" "}
                <strong className="font-medium text-foreground">
                  Recommended.
                </strong>
              </>
            }
            defaultChecked
          />
          <AccessRadio
            value="deny"
            label="Deny"
            description={
              <>
                Agents have no access until you grant it explicitly.{" "}
                <strong className="font-medium text-foreground">
                  Strictest;
                </strong>{" "}
                useful when you want allowlisting from day one.
              </>
            }
          />
          <AccessRadio
            value="read_write"
            label="Read + write"
            description={
              <>
                Agents can read and write any table.{" "}
                <strong className="font-medium text-foreground">
                  Not recommended
                </strong>{" "}
                outside one-shot migration tokens.
              </>
            }
          />
        </div>
      </fieldset>
      {state.error ? (
        <p
          id="new-connection-error"
          role="alert"
          className="text-sm text-destructive"
        >
          {state.error}
          {state.upgradeUrl ? (
            <>
              {" "}
              <a
                href={state.upgradeUrl}
                className="font-medium text-foreground underline underline-offset-2"
              >
                Upgrade your plan
              </a>
              .
            </>
          ) : null}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="lg" arrow disabled={pending}>
          {pending ? "Creating…" : "Create connection"}
        </Button>
        <TestDsnButton
          key={testVersion}
          endpoint="/api/connections/test-dsn"
          disabled={pending}
        />
      </div>
    </form>
  );
}
