"use client";

// Tenant scoping editor — OSS 0.5.0 wire shape.
//
// Two top-level states the operator can be in:
//
//   OFF   Agent queries return rows for every tenant. Save commits
//         EMPTY_TENANT_SCOPE; the YAML omits the block.
//
//   ON    Default tenant column applied to every queried table; tables
//         without that column are denied at query time unless listed as
//         exempt. Per-table overrides let one table use a different
//         column.
//
// The toggle is the unambiguous source of truth: when OFF, the column +
// exception fields are hidden and Save commits the inert envelope
// regardless of what's in the form state. We keep form state across
// toggle flips so a stray off→on doesn't wipe a customer's existing
// rows until they explicitly Remove them.

import { useState, useTransition } from "react";

// Pure-types subpath — the bare `@midplane-cloud/db` entrypoint pulls in
// `postgres` (Node-only) transitively via getDb, which would crash the
// client bundle with `Can't resolve 'fs'`. permission-grid uses this same
// subpath for the same reason.
import {
  EMPTY_TENANT_SCOPE,
  tenantScopeIsActive,
  type TenantScopeConfig,
} from "@midplane-cloud/db/policy";

import { Button } from "@/components/ui/button";
import { TableNameInput } from "@/components/table-name-input";
import { cn } from "@/lib/utils";

// Mirrors the server-side regexes in @midplane-cloud/db/policy.
//   IDENT_RE        — single column identifier (default tenant column,
//                     per-table override column value).
//   TABLE_IDENT_RE  — table identifier, optionally schema-qualified.
//                     Matches the autocomplete (`public.users`) shape
//                     and table_access's existing pattern.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;

type RowKind = "override" | "exempt";

interface ScopeRow {
  // Stable client-side key so React doesn't reuse inputs across reorders.
  key: string;
  table: string;
  kind: RowKind;
  /** Column name when kind="override"; ignored when kind="exempt". */
  overrideColumn: string;
}

export function TenantScopeEditor({
  initialConfig,
  projectId,
  action,
}: {
  initialConfig: TenantScopeConfig;
  /** For the table-name autocomplete (introspects the customer's DB
   *  schema). Same endpoint the permission grid uses. */
  projectId: string;
  // Server action signature: (FormData) => Promise<void>. The form
  // posts a single `config` field with JSON-encoded TenantScopeConfig.
  action: (formData: FormData) => Promise<void>;
}) {
  // `applied` is the config currently committed to the server — the
  // baseline for the dirty check. It starts as the prop and shifts to
  // whatever we just saved on every successful submit. The form state
  // below lives independently and only catches up to `applied` on
  // mount, save, or explicit Cancel.
  //
  // Toggle starts ON iff the stored config is active (column set OR
  // overrides non-empty). Exempt-only configs are inert per the OSS
  // wire shape, so they read as OFF here even though `exempt` is
  // populated — the row state is still preserved in case the operator
  // flips back on.
  const [applied, setApplied] = useState<TenantScopeConfig>(initialConfig);
  const [enabled, setEnabled] = useState<boolean>(
    tenantScopeIsActive(initialConfig),
  );
  const [defaultColumn, setDefaultColumn] = useState<string>(
    initialConfig.column ?? "",
  );
  const [rows, setRows] = useState<ScopeRow[]>(() => initialRows(initialConfig));
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  const trimmedDefault = defaultColumn.trim();
  const hasDefault = enabled && trimmedDefault.length > 0;

  // Build a (possibly invalid) snapshot of what the form currently
  // represents — skip empty placeholder rows and incomplete overrides
  // so half-typed entries don't dirty the form until they're complete.
  // Save still re-validates the strict version before pushing.
  const currentSnapshot = formToConfig(enabled, defaultColumn, rows);
  const dirty = canonicalize(currentSnapshot) !== canonicalize(applied);

  function clearStatus() {
    setError(null);
    setSavedAt(null);
  }

  function addRow(kind: RowKind) {
    setRows((rs) => [
      ...rs,
      { key: `new-${Date.now()}-${rs.length}`, table: "", kind, overrideColumn: "" },
    ]);
    clearStatus();
  }

  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
    clearStatus();
  }

  function updateRow(key: string, patch: Partial<ScopeRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    clearStatus();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // OFF short-circuits to the inert envelope. Form state stays in
    // place client-side so a stray flip can be reversed without losing
    // the operator's exceptions.
    let config: TenantScopeConfig;
    if (enabled) {
      const built = buildConfig();
      // buildConfig sets the error state and returns null on a
      // validation failure; just bail.
      if (!built) return;
      config = built;
    } else {
      config = EMPTY_TENANT_SCOPE;
    }

    const fd = new FormData();
    fd.set("config", JSON.stringify(config));

    startTransition(async () => {
      try {
        await action(fd);
        // Promote what we just sent to the new baseline so the Save +
        // Cancel buttons settle to "no changes" without waiting for the
        // server-component re-render to refresh initialConfig.
        setApplied(config);
        setSavedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    });

    function buildConfig(): TenantScopeConfig | null {
      const column = trimmedDefault === "" ? null : trimmedDefault;
      if (column !== null && !IDENT_RE.test(column)) {
        setError(`Invalid default column: ${column}`);
        return null;
      }

      const overrides: Record<string, string> = {};
      const exempt: string[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const table = r.table.trim();
        if (table.length === 0) continue;
        if (!TABLE_IDENT_RE.test(table)) {
          setError(`Invalid table name: ${table}`);
          return null;
        }
        if (seen.has(table)) {
          setError(`Duplicate table: ${table}`);
          return null;
        }
        seen.add(table);
        if (r.kind === "override") {
          const col = r.overrideColumn.trim();
          if (col.length === 0) {
            setError(`Override for ${table} needs a column name.`);
            return null;
          }
          if (!IDENT_RE.test(col)) {
            setError(`Invalid override column: ${col}`);
            return null;
          }
          overrides[table] = col;
        } else {
          exempt.push(table);
        }
      }

      // Catch the user-error case: toggle is on but nothing is
      // configured. Empty config under ON would silently round-trip to
      // disabled on the next page load (since tenantScopeIsActive
      // returns false for it), which would surprise the operator. Make
      // them either set a column, add an override, or turn the toggle off.
      if (column === null && Object.keys(overrides).length === 0) {
        setError(
          "Tenant scoping is on but nothing is configured. Set a default column, add an override, or turn scoping off.",
        );
        return null;
      }

      return { column, overrides, exempt };
    }
  }

  const usedNames = new Set(
    rows.map((r) => r.table.trim()).filter((n) => n.length > 0),
  );

  function handleCancel() {
    // Revert form state to whatever's currently applied on the server
    // (page-load config, or the most recent successful save). New row
    // keys land via initialRows so React remounts inputs cleanly.
    setEnabled(tenantScopeIsActive(applied));
    setDefaultColumn(applied.column ?? "");
    setRows(initialRows(applied));
    setError(null);
    setSavedAt(null);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <EnabledToggle
        enabled={enabled}
        onChange={(next) => {
          setEnabled(next);
          clearStatus();
        }}
      />

      {enabled && (
        <div className="space-y-4 border-l-2 border-border pl-4">
          <div className="space-y-1.5">
            <label
              htmlFor="default-column"
              className="text-sm font-medium text-foreground"
            >
              Default tenant column
            </label>
            <input
              id="default-column"
              type="text"
              value={defaultColumn}
              onChange={(e) => {
                setDefaultColumn(e.target.value);
                clearStatus();
              }}
              placeholder="tenant_id"
              autoComplete="off"
              spellCheck={false}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              {hasDefault ? (
                <>
                  Agent queries get{" "}
                  <span className="font-mono">
                    WHERE {trimmedDefault} = {"<"}session tenant{">"}
                  </span>{" "}
                  appended on every table. Tables without this column are
                  denied unless listed as exempt.
                </>
              ) : (
                <>
                  Without a default column only the tables you list below
                  are scoped — every other table the agent queries returns
                  rows for all tenants.
                </>
              )}
            </p>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium text-foreground">Exceptions</div>
            {rows.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {hasDefault
                  ? "All tables are scoped on the default column. Add an exception if a table uses a different column or is intentionally tenant-free."
                  : "No tables scoped yet. Add a per-table override below, or set a default column above to scope everything."}
              </p>
            ) : (
              <ul className="space-y-2">
                {rows.map((r) => (
                  <li
                    key={r.key}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-2"
                    data-testid="scope-row"
                    data-kind={r.kind}
                  >
                    <TableNameInput
                      value={r.table}
                      onChange={(v) => updateRow(r.key, { table: v })}
                      projectId={projectId}
                      excludeNames={
                        new Set(
                          [...usedNames].filter((n) => n !== r.table.trim()),
                        )
                      }
                    />
                    <select
                      value={r.kind}
                      onChange={(e) =>
                        updateRow(r.key, { kind: e.target.value as RowKind })
                      }
                      aria-label="Scope action"
                      className="flex h-9 rounded-md border border-input bg-background px-2 py-1 text-sm"
                    >
                      <option value="override">Override column</option>
                      <option value="exempt">Exempt (no scoping)</option>
                    </select>
                    {r.kind === "override" ? (
                      <input
                        type="text"
                        value={r.overrideColumn}
                        onChange={(e) =>
                          updateRow(r.key, { overrideColumn: e.target.value })
                        }
                        placeholder="org_id"
                        aria-label="Override column"
                        autoComplete="off"
                        spellCheck={false}
                        className="flex h-9 w-32 rounded-md border border-input bg-background px-3 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      />
                    ) : (
                      <ExemptHint />
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRow(r.key)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addRow("override")}
              >
                + Override column
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => addRow("exempt")}
              >
                + Mark exempt
              </Button>
            </div>
          </div>
        </div>
      )}

      {!enabled && (
        <p className="text-xs text-muted-foreground">
          Tenant scoping is off. Agent queries return rows for every tenant
          on every table. Enable to start filtering by a session tenant.
        </p>
      )}

      {error ? (
        <p className="text-xs text-[hsl(var(--deny))]" data-testid="scope-error">
          {error}
        </p>
      ) : null}
      {savedAt ? (
        <p className="text-xs text-muted-foreground">
          Saved. Changes take effect on the next agent request — running
          sessions keep working.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save tenant scoping"}
        </Button>
        {dirty && !pending && (
          <Button
            type="button"
            variant="ghost"
            onClick={handleCancel}
            data-testid="scope-cancel"
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

// Lenient form → config builder for the dirty-check path. Skips empty
// placeholder rows and overrides whose column hasn't been typed yet so
// half-complete entries don't enable Save. The submit path uses its
// own builder with strict validation; both paths produce the same
// shape once the form is fully filled.
function formToConfig(
  enabled: boolean,
  defaultColumn: string,
  rows: ScopeRow[],
): TenantScopeConfig {
  if (!enabled) return EMPTY_TENANT_SCOPE;
  const trimmed = defaultColumn.trim();
  const column = trimmed.length === 0 ? null : trimmed;
  const overrides: Record<string, string> = {};
  const exempt: string[] = [];
  for (const r of rows) {
    const table = r.table.trim();
    if (!table) continue;
    if (r.kind === "override") {
      const col = r.overrideColumn.trim();
      if (col) overrides[table] = col;
    } else if (!exempt.includes(table)) {
      exempt.push(table);
    }
  }
  return { column, overrides, exempt };
}

// Canonical string for compare. Sorts overrides + exempt so insertion
// order doesn't fool the equality check. Inert configs collapse to a
// single sentinel — overrides-only vs strict configs stay distinct
// because column flips from null to a string.
function canonicalize(config: TenantScopeConfig): string {
  if (!tenantScopeIsActive(config) && config.exempt.length === 0) {
    return "OFF";
  }
  const sortedOverrides = Object.keys(config.overrides)
    .sort()
    .map((k) => [k, config.overrides[k]]);
  const sortedExempt = [...config.exempt].sort();
  return JSON.stringify({
    column: config.column,
    overrides: sortedOverrides,
    exempt: sortedExempt,
  });
}

function EnabledToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
}) {
  // Two-button segmented control mirrors the radio-style pattern in
  // permission-grid.tsx (default-access selector) so the page reads
  // consistently. role=radiogroup so screen readers announce the pair
  // and arrow keys move between them.
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium text-foreground">
        Tenant scoping
      </legend>
      <div
        role="radiogroup"
        aria-label="Tenant scoping enabled"
        className="inline-flex rounded-md border border-border bg-secondary p-0.5"
      >
        <ToggleOption
          label="Off"
          active={!enabled}
          tone="neutral"
          onClick={() => onChange(false)}
        />
        <ToggleOption
          label="On"
          active={enabled}
          tone="allow"
          onClick={() => onChange(true)}
        />
      </div>
    </fieldset>
  );
}

function ToggleOption({
  label,
  active,
  tone,
  onClick,
}: {
  label: string;
  active: boolean;
  /** Off is neutral; On is `allow` so an enabled scope reads as
   *  "filtering is active and protective" at a glance. */
  tone: "neutral" | "allow";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={cn(
        "rounded-[4px] px-3 py-1 text-xs font-medium transition-colors",
        active
          ? tone === "allow"
            ? "bg-allow/15 text-allow"
            : "bg-background text-foreground"
          : "text-subtle hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function initialRows(config: TenantScopeConfig): ScopeRow[] {
  const overrides = Object.entries(config.overrides)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map<ScopeRow>(([table, col], i) => ({
      key: `o-${i}`,
      table,
      kind: "override",
      overrideColumn: col,
    }));
  const exempt = [...config.exempt]
    .sort()
    .map<ScopeRow>((table, i) => ({
      key: `e-${i}`,
      table,
      kind: "exempt",
      overrideColumn: "",
    }));
  return [...overrides, ...exempt];
}

function ExemptHint() {
  return (
    <span className="inline-flex items-center rounded-[3px] border border-border bg-secondary px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.04em] text-subtle">
      no scope
    </span>
  );
}
