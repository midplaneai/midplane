"use client";

// Permission grid for the table_access policy on a project.
//
// Edits the JSONB policy stored on projects.table_access. On Save,
// posts the whole policy as a single JSON-encoded form field; the server
// action validates it again (defense-in-depth — the engine also
// re-validates) and calls setTableAccess(), which writes Postgres and
// then POSTs the new YAML to the engine's /admin/policy so the agent's
// MCP session keeps running. EnginePolicyRejected from the server
// action surfaces as the form's error string.
//
// State model: keep tables as an ordered array internally so add/remove/
// reorder work naturally. We serialize back to a Record<string,level>
// at submit time. Duplicate names are caught client-side AND on the
// server; the client message is just a UX nicety.
//
// Autocomplete: each row owns its own debounced fetch against
// GET /api/projects/:id/tables?q=<substring>. The endpoint runs an
// information_schema lookup against the customer's own DB (KMS-decrypted
// server-side). 150ms debounce avoids flooding the catalog on every
// keystroke; an AbortController per request keeps a fast typer from
// racing two responses. The browser cache (private max-age=10) makes
// re-focusing the same input a no-op. Errors surface inline in the
// dropdown panel — no parent-level chip.

import { useCallback, useState, useTransition } from "react";

import {
  ACCESS_LEVELS,
  type AccessLevel,
  type TableAccessPolicy,
} from "@midplane-cloud/db/policy";

import { Button } from "@/components/ui/button";
import { TableNameInput } from "@/components/table-name-input";
import { cn } from "@/lib/utils";

// Matrix layout: tables are rows, access levels are columns. Each row is
// a labeled segmented control (deny / read / read+write); the default for
// unlisted tables is the pinned top row, so the catch-all and the explicit
// overrides pick a level the same way instead of a segmented control + a
// per-row dropdown. Shared grid template keeps the default row and the
// override rows column-aligned, so deny/read/write line up down the table.
const GRID_COLS =
  "grid grid-cols-[minmax(11rem,1.5fr)_repeat(3,minmax(6rem,1fr))_2.75rem] items-stretch";

interface TableRow {
  // Stable client-side key so React doesn't reuse inputs across reorders.
  // It is ALSO rendered into each radio's `name` attribute (groupName),
  // so it must be deterministic across server and client renders — see
  // policyToRows: no Date.now() in the initial keys, or hydration breaks.
  key: string;
  name: string;
  level: AccessLevel;
}

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;

export function PermissionGrid({
  initialPolicy,
  action,
  projectId,
  dbName,
}: {
  initialPolicy: TableAccessPolicy;
  // Server action signature: (FormData) => Promise<void>. The form
  // contains a single `policy` field with JSON-encoded TableAccessPolicy.
  action: (formData: FormData) => Promise<void>;
  projectId: string;
  /** Database the grid edits — scopes the autocomplete's introspection
   *  to the right DB (the tables route is per-db). */
  dbName?: string;
}) {
  // `applied` is the policy currently committed to the server — the
  // baseline for the dirty check. It starts as the prop and shifts to
  // whatever we just saved on every successful submit so Save / Cancel
  // settle to "no changes" without waiting for a server re-render.
  const [applied, setApplied] = useState<TableAccessPolicy>(initialPolicy);
  const [defaultLevel, setDefaultLevel] = useState<AccessLevel>(
    initialPolicy.default,
  );
  const [rows, setRows] = useState<TableRow[]>(() => policyToRows(initialPolicy));
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  // Lenient form → policy snapshot for the dirty check. Skips empty
  // placeholder rows so a half-typed name doesn't enable Save until the
  // user finishes (Save still re-validates the strict version).
  const currentSnapshot: TableAccessPolicy = {
    default: defaultLevel,
    tables: rows.reduce<Record<string, AccessLevel>>((acc, r) => {
      const name = r.name.trim();
      if (name) acc[name] = r.level;
      return acc;
    }, {}),
  };
  const dirty = canonicalize(currentSnapshot) !== canonicalize(applied);

  function addRow() {
    setRows((rs) => [
      ...rs,
      { key: `new-${Date.now()}-${rs.length}`, name: "", level: "read" },
    ]);
    setError(null);
    setSavedAt(null);
  }

  function removeRow(key: string) {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setError(null);
    setSavedAt(null);
  }

  const updateRow = useCallback((key: string, patch: Partial<TableRow>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setError(null);
    setSavedAt(null);
  }, []);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    // Pre-flight validation matching policy.ts on the server. Caught
    // here for nicer messaging; the server still re-validates.
    const trimmed = rows.map((r) => ({ ...r, name: r.name.trim() }));
    const seen = new Set<string>();
    for (const r of trimmed) {
      if (r.name.length === 0) {
        setError("Table name is required for every row.");
        return;
      }
      if (!TABLE_NAME_RE.test(r.name)) {
        setError(`Invalid table name: ${r.name}`);
        return;
      }
      if (seen.has(r.name)) {
        setError(`Duplicate table: ${r.name}`);
        return;
      }
      seen.add(r.name);
    }

    const policy: TableAccessPolicy = {
      default: defaultLevel,
      tables: Object.fromEntries(trimmed.map((r) => [r.name, r.level])),
    };

    const fd = new FormData();
    fd.set("id", projectId);
    fd.set("policy", JSON.stringify(policy));

    startTransition(async () => {
      try {
        await action(fd);
        // Promote what we just sent to the new baseline so Save +
        // Cancel settle to "no changes" without waiting for the
        // server-component re-render to refresh initialPolicy.
        setApplied(policy);
        setSavedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

  function handleCancel() {
    setDefaultLevel(applied.default);
    setRows(policyToRows(applied));
    setError(null);
    setSavedAt(null);
  }

  // Names already chosen in OTHER rows — passed to each row's combobox so
  // the dropdown doesn't suggest a name that's already taken elsewhere.
  // (We allow a row to keep its own name in the list — the regex check
  // catches dupes at save time.)
  const usedNames = new Set(rows.map((r) => r.name).filter((n) => n.length > 0));

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div
        className="border border-border"
        role="group"
        aria-label="Table access policy"
      >
        {/* Default row — the catch-all, pinned at the top and held on
            --card so it reads as the fallback. No header band: every
            segment is labeled, so the first row doubles as the legend.
            The label mirrors the name inputs' font + text offset (px-3
            inside an h-9 box) so it lines up with the rows below. */}
        <div
          className={cn(GRID_COLS, "border-b-2 border-border bg-card")}
          role="radiogroup"
          aria-label="Default access for unlisted tables"
        >
          <div className="flex items-center px-2 py-1">
            <span className="flex h-9 items-center px-3 font-mono text-sm text-muted-foreground">
              unlisted tables
            </span>
          </div>
          {ACCESS_LEVELS.map((level) => (
            <LevelCell
              key={level}
              level={level}
              selected={defaultLevel === level}
              groupName="default-level"
              rowLabel="unlisted tables"
              onSelect={() => {
                setDefaultLevel(level);
                setSavedAt(null);
              }}
            />
          ))}
          <div className="border-l border-border" aria-hidden />
        </div>

        {/* Explicit per-table overrides */}
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">
            No overrides — the default above applies to every table.
          </p>
        ) : (
          rows.map((r) => {
            const label = r.name.trim() || "new table";
            return (
              <div
                key={r.key}
                className={cn(
                  GRID_COLS,
                  "border-b border-border last:border-b-0",
                )}
                role="radiogroup"
                aria-label={`Access for ${label}`}
                data-testid="permission-row"
              >
                <div className="flex items-center px-2 py-1">
                  <TableNameInput
                    value={r.name}
                    onChange={(v) => updateRow(r.key, { name: v })}
                    projectId={projectId}
                    dbName={dbName}
                    excludeNames={
                      new Set([...usedNames].filter((n) => n !== r.name))
                    }
                  />
                </div>
                {ACCESS_LEVELS.map((level) => (
                  <LevelCell
                    key={level}
                    level={level}
                    selected={r.level === level}
                    groupName={`level-${r.key}`}
                    rowLabel={label}
                    onSelect={() => updateRow(r.key, { level })}
                  />
                ))}
                <div className="flex items-center justify-center border-l border-border">
                  <button
                    type="button"
                    onClick={() => removeRow(r.key)}
                    aria-label={`Remove ${label}`}
                    className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      <Button type="button" variant="outline" size="sm" onClick={addRow}>
        + Add table
      </Button>

      {error ? (
        <p className="text-xs text-destructive" data-testid="permission-error">
          {error}
        </p>
      ) : null}
      {savedAt ? (
        <p className="text-xs text-muted-foreground">
          Saved. Permission changes take effect immediately without
          interrupting active agent sessions.
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !dirty}>
          {pending ? "Saving…" : "Save permissions"}
        </Button>
        {dirty && !pending && (
          <Button
            type="button"
            variant="ghost"
            onClick={handleCancel}
            data-testid="permission-cancel"
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

// A single segment in a row's access control: one level, always labeled.
// The whole cell is the click target (a label wrapping an sr-only radio).
// Unselected segments are muted text; the selected one takes the level's
// semantic color + a faint tint of it, so a row reads its access level
// from the one cell that's lit. No dot — the label is self-describing, so
// the three segments together read as a per-row segmented control. Each
// row owns a unique `groupName` so native radio grouping (arrow-key nav)
// stays row-scoped — the policy is built from React state at submit, not
// these field names, so the names are free to be per-row.
function LevelCell({
  level,
  selected,
  groupName,
  rowLabel,
  onSelect,
}: {
  level: AccessLevel;
  selected: boolean;
  groupName: string;
  rowLabel: string;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center justify-center border-l border-border py-2 font-mono text-xs lowercase tracking-[0.02em] transition-colors",
        selected
          ? LEVEL_SELECTED_CLASS[level]
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <input
        type="radio"
        name={groupName}
        value={level}
        checked={selected}
        onChange={onSelect}
        aria-label={`${rowLabel}: ${LEVEL_LABEL[level]}`}
        className="sr-only"
      />
      {LEVEL_LABEL[level]}
    </label>
  );
}

// Source case is canonical (Title Case); segments render it lowercase via
// CSS so screen readers still announce "Read + write" (DESIGN.md voice
// split).
const LEVEL_LABEL: Record<AccessLevel, string> = {
  deny: "Deny",
  read: "Read",
  read_write: "Read + write",
};

// Semantic-color vocabulary from DESIGN.md: deny=red, read=warn (cautious
// middle), read_write=allow (open). The selected segment takes the level's
// color as both text and a faint background tint; unselected segments stay
// neutral so the lit one is unambiguous.
const LEVEL_SELECTED_CLASS: Record<AccessLevel, string> = {
  deny: "bg-deny/10 font-medium text-deny",
  read: "bg-warn/10 font-medium text-warn",
  read_write: "bg-allow/10 font-medium text-allow",
};

function policyToRows(policy: TableAccessPolicy): TableRow[] {
  return Object.entries(policy.tables)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    // Deterministic key by index — NOT Date.now(). This useState
    // initializer runs on both the server render and the client
    // hydration; a timestamp would differ between the two and the key
    // is rendered into the radio `name`, producing a hydration mismatch.
    // The index is stable for the initial rows and independent of the
    // editable table name (so typing a name doesn't remount the input).
    // addRow's keys can stay timestamp-based: those rows are created by a
    // post-hydration click, so they have no server render to disagree with.
    .map(([name, level], i) => ({ key: `init-${i}`, name, level }));
}

// Canonical string for compare. Sorts table entries so insertion
// order doesn't fool the equality check.
function canonicalize(policy: TableAccessPolicy): string {
  const sorted = Object.keys(policy.tables)
    .sort()
    .map((k) => [k, policy.tables[k]]);
  return JSON.stringify({ default: policy.default, tables: sorted });
}
