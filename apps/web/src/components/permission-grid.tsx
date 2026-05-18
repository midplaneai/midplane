"use client";

// Permission grid for the table_access policy on a connection.
//
// Edits the JSONB policy stored on connections.table_access. On Save,
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
// GET /api/connections/:id/tables?q=<substring>. The endpoint runs an
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

interface TableRow {
  // Stable client-side key so React doesn't reuse inputs across reorders.
  key: string;
  name: string;
  level: AccessLevel;
}

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;

export function PermissionGrid({
  initialPolicy,
  action,
  connectionId,
}: {
  initialPolicy: TableAccessPolicy;
  // Server action signature: (FormData) => Promise<void>. The form
  // contains a single `policy` field with JSON-encoded TableAccessPolicy.
  action: (formData: FormData) => Promise<void>;
  connectionId: string;
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
    fd.set("id", connectionId);
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
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">
          Default for unlisted tables
        </legend>
        <div className="flex flex-wrap gap-2">
          {ACCESS_LEVELS.map((level) => (
            <label
              key={level}
              className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                defaultLevel === level
                  ? "border-primary bg-primary/5"
                  : "hover:bg-accent"
              }`}
            >
              <input
                type="radio"
                name="default_preview"
                value={level}
                checked={defaultLevel === level}
                onChange={() => {
                  setDefaultLevel(level);
                  setSavedAt(null);
                }}
                className="sr-only"
              />
              {LEVEL_LABEL[level]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="space-y-2">
        <div className="text-sm font-medium">Per-table overrides</div>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No overrides. The default above applies to every table.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.key}
                className="flex flex-wrap items-center gap-2 rounded-md border bg-card p-2"
                data-testid="permission-row"
              >
                <TableNameInput
                  value={r.name}
                  onChange={(v) => updateRow(r.key, { name: v })}
                  connectionId={connectionId}
                  excludeNames={
                    new Set([...usedNames].filter((n) => n !== r.name))
                  }
                />
                <select
                  value={r.level}
                  onChange={(e) =>
                    updateRow(r.key, { level: e.target.value as AccessLevel })
                  }
                  aria-label="Access level"
                  className="flex h-9 rounded-md border border-input bg-background px-2 py-1 text-sm"
                >
                  {ACCESS_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {LEVEL_LABEL[level]}
                    </option>
                  ))}
                </select>
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
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          + Add table
        </Button>
      </div>

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

const LEVEL_LABEL: Record<AccessLevel, string> = {
  deny: "Deny",
  read: "Read",
  read_write: "Read + write",
};

function policyToRows(policy: TableAccessPolicy): TableRow[] {
  return Object.entries(policy.tables)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, level], i) => ({ key: `init-${i}-${Date.now()}`, name, level }));
}

// Canonical string for compare. Sorts table entries so insertion
// order doesn't fool the equality check.
function canonicalize(policy: TableAccessPolicy): string {
  const sorted = Object.keys(policy.tables)
    .sort()
    .map((k) => [k, policy.tables[k]]);
  return JSON.stringify({ default: policy.default, tables: sorted });
}
