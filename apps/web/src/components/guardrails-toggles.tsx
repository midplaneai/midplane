"use client";

// Guardrails editor — two categorical statement blocks (OSS 0.9.0) that
// fire regardless of the table matrix above:
//
//   block_unqualified_dml   DELETE / UPDATE with no WHERE clause
//   block_ddl               DROP / TRUNCATE / ALTER
//
// Each row is an explicit two-segment block/allow control (same shape as
// the permission grid's LevelCell — no implicit "empty means off" state).
// Block takes the deny color because a blocked statement is a denied
// query; Allow deliberately takes WARN, not allow-green — permitting
// destructive statements is an opted-into risk state, the same anomaly
// amber as the panel's writable-default callout. Block sits leftmost so
// the deny-red column lands on the same side as the permission grid's
// deny column directly above (restrictive-left, one red edge across both
// cards). Both ship ON: allowing is the opt-out, saved deliberately.
//
// Save posts the whole config as one JSON form field; the server action
// validates again and calls setGuardrails(), which writes Postgres and
// hot-reloads the running engine (same path as the permission grid).

import { useState, useTransition } from "react";

// Pure-types subpath — the bare `@midplane-cloud/db` entrypoint pulls in
// `postgres` (Node-only) via getDb, which would crash the client bundle
// with `Can't resolve 'fs'`. Same as permission-grid / tenant-scope-editor.
import type { GuardrailsConfig } from "@midplane-cloud/db/policy";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const GRID_COLS =
  "grid grid-cols-[minmax(11rem,2fr)_repeat(2,minmax(6rem,1fr))] items-stretch";

// SQL keywords are UPPERCASE, prose stays lowercase — all-lowercase made
// "with no where" read as English ("nowhere"), hiding that WHERE is the
// missing clause. Keywords are codes, the same carve-out DESIGN.md gives
// EU/US and badge text; whole-label uppercase stays an anti-pattern.
const ROWS: Array<{
  key: keyof GuardrailsConfig;
  label: string;
  hint: string;
}> = [
  {
    key: "block_unqualified_dml",
    label: "DELETE / UPDATE with no WHERE",
    hint: "statements that would touch every row",
  },
  {
    key: "block_ddl",
    label: "DROP / TRUNCATE / ALTER",
    hint: "CREATE is unaffected — migrations still work",
  },
];

export function GuardrailsToggles({
  initialConfig,
  action,
}: {
  initialConfig: GuardrailsConfig;
  // Server action signature: (FormData) => Promise<void>. The form posts
  // a single `guardrails` field with JSON-encoded GuardrailsConfig.
  action: (formData: FormData) => Promise<void>;
}) {
  // `applied` is the config currently committed to the server — the
  // baseline for the dirty check; it shifts to whatever we just saved on
  // every successful submit (same model as the permission grid).
  const [applied, setApplied] = useState<GuardrailsConfig>(initialConfig);
  const [config, setConfig] = useState<GuardrailsConfig>(initialConfig);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty =
    config.block_unqualified_dml !== applied.block_unqualified_dml ||
    config.block_ddl !== applied.block_ddl;

  function setFlag(key: keyof GuardrailsConfig, value: boolean) {
    setConfig((c) => ({ ...c, [key]: value }));
    setError(null);
    setSaved(false);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const fd = new FormData();
    fd.set("guardrails", JSON.stringify(config));
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

  function handleCancel() {
    setConfig(applied);
    setError(null);
    setSaved(false);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div
        className="border border-border"
        role="group"
        aria-label="Statement guardrails"
      >
        {ROWS.map(({ key, label, hint }) => (
          <div
            key={key}
            className={cn(GRID_COLS, "border-b border-border last:border-b-0")}
            role="radiogroup"
            aria-label={`Guardrail: ${label}`}
            data-testid="guardrail-row"
          >
            <div className="flex flex-col justify-center px-3 py-2">
              <span className="font-mono text-sm text-foreground">{label}</span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </div>
            <GuardrailCell
              label="Block"
              selected={config[key]}
              groupName={`guardrail-${key}`}
              rowLabel={label}
              selectedClass="bg-deny/10 font-medium text-deny"
              onSelect={() => setFlag(key, true)}
            />
            <GuardrailCell
              label="Allow"
              selected={!config[key]}
              groupName={`guardrail-${key}`}
              rowLabel={label}
              selectedClass="bg-warn/10 font-medium text-warn"
              onSelect={() => setFlag(key, false)}
            />
          </div>
        ))}
      </div>

      {error ? (
        <p className="text-xs text-destructive" data-testid="guardrails-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        // No "immediately / without interrupting" promise: on the
        // fail-soft paths (engine unreachable, hot-reload 5xx) the change
        // lands on the engine's next start, and the respawn fallback does
        // drop the running session. The wording has to be true on every
        // success path the server action can return from.
        <p className="text-xs text-muted-foreground">
          Saved. A running engine picks this up in place; otherwise it
          applies when the engine next starts.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save guardrails"}
        </Button>
        {dirty && !pending && (
          <Button
            type="button"
            variant="ghost"
            onClick={handleCancel}
            data-testid="guardrails-cancel"
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

// One segment of a row's block/allow control — the whole cell is the
// click target (a label wrapping an sr-only radio), mirroring the
// permission grid's LevelCell so the two cards read as one system.
function GuardrailCell({
  label,
  selected,
  groupName,
  rowLabel,
  selectedClass,
  onSelect,
}: {
  label: string;
  selected: boolean;
  groupName: string;
  rowLabel: string;
  selectedClass: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center justify-center border-l border-border py-2 font-mono text-xs lowercase tracking-[0.02em] transition-colors",
        selected
          ? selectedClass
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <input
        type="radio"
        name={groupName}
        value={label.toLowerCase()}
        checked={selected}
        onChange={onSelect}
        aria-label={`${rowLabel}: ${label}`}
        className="sr-only"
      />
      {label}
    </label>
  );
}
