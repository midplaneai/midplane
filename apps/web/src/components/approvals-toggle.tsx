"use client";

// Write-approvals toggle — one switch, deliberately.
//
// The trigger is categorical rather than a row threshold: the noise floor is
// already set by table_access, since only a table marked `read_write` can
// produce a held write at all. "Writes need approval" therefore means "writes to
// the handful of tables you already decided an agent may write to".
//
// Sits below Guardrails in the Database pane because that is the precedence:
// approvals run only on statements the policy ALREADY allows, so a guardrail
// refusal never reaches a human and no approval can buy a way past one.

import { useState, useTransition } from "react";

import type { ApprovalsConfig } from "@midplane-cloud/db/policy";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ApprovalsToggle({
  initialConfig,
  action,
  gateConfigured = true,
}: {
  initialConfig: ApprovalsConfig;
  action: (formData: FormData) => Promise<void>;
  /** Whether this deployment has an approval secret + origin. The server
   *  action refuses the save without them; showing it here means the user
   *  learns before clicking rather than from a rejected save. */
  gateConfigured?: boolean;
}) {
  const [applied, setApplied] = useState<ApprovalsConfig>(initialConfig);
  const [config, setConfig] = useState<ApprovalsConfig>(initialConfig);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = config.writes !== applied.writes;

  function setWrites(value: boolean) {
    setConfig((c) => ({ ...c, writes: value }));
    setError(null);
    setSaved(false);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const fd = new FormData();
    fd.set("approvals", JSON.stringify(config));
    startTransition(async () => {
      try {
        await action(fd);
        setApplied(config);
        setSaved(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div
        className="border border-border"
        role="radiogroup"
        aria-label="Write approvals"
      >
        <div className="grid grid-cols-[minmax(11rem,2fr)_repeat(2,minmax(6rem,1fr))] items-stretch">
          <div className="flex flex-col justify-center px-3 py-2">
            <span className="font-mono text-sm text-foreground">
              INSERT / UPDATE / DELETE
            </span>
            <span className="text-xs text-muted-foreground">
              writes to any table set to read_write
            </span>
          </div>
          <Cell
            label="Run"
            selected={!config.writes}
            groupName="approvals-writes"
            selectedClass="bg-foreground/10 font-medium text-foreground"
            onSelect={() => setWrites(false)}
          />
          <Cell
            label="Approve"
            selected={config.writes}
            groupName="approvals-writes"
            // Brand, not warn: amber already means "write" in the permission
            // grid and "allow destructive" in guardrails on this same screen, so
            // reusing it here would read as a third unrelated thing.
            selectedClass="bg-[hsl(var(--brand)/0.16)] font-medium text-foreground shadow-[inset_0_-2px_0_hsl(var(--brand))]"
            onSelect={() => setWrites(true)}
          />
        </div>
      </div>

      {!gateConfigured && (
        <p className="border-l-[3px] border-warn bg-warn/[0.06] px-3 py-2 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">
            This deployment has no approval service configured.
          </strong>{" "}
          Set <code className="font-mono">MIDPLANE_APPROVAL_SECRET</code> and{" "}
          <code className="font-mono">MIDPLANE_APP_ORIGIN</code> first — without
          them the engine has no way to ask anyone, so every write would be
          refused and nothing would appear in the queue.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Reads are never held. If a read needs a human, deny the table instead —
        adding a review step to <code className="font-mono">SELECT</code> makes
        the agent useless without making anything safer.
      </p>

      {error ? (
        <p className="text-xs text-destructive" data-testid="approvals-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="text-xs text-muted-foreground">
          Saved. A running engine picks this up in place; otherwise it applies
          when the engine next starts.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={pending || !dirty || (config.writes && !gateConfigured)}
        >
          {pending ? "Saving…" : "Save approvals"}
        </Button>
        {dirty && !pending && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setConfig(applied);
              setError(null);
              setSaved(false);
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

// One segment of the run/approve control. The whole cell is the click target —
// a label wrapping an sr-only radio — mirroring GuardrailsToggles so the two
// cards read as one system.
function Cell({
  label,
  selected,
  groupName,
  selectedClass,
  onSelect,
}: {
  label: string;
  selected: boolean;
  groupName: string;
  selectedClass: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center justify-center border-l border-border px-2 py-2 text-center text-sm transition-colors",
        selected ? selectedClass : "text-subtle hover:text-muted-foreground",
      )}
    >
      <input
        type="radio"
        name={groupName}
        className="sr-only"
        checked={selected}
        onChange={onSelect}
      />
      {label}
    </label>
  );
}
