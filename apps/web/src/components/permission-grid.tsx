"use client";

// Permission grid for the table_access policy on a connection.
//
// Edits the JSONB policy stored on connections.table_access. On Save,
// posts the whole policy as a single JSON-encoded form field; the server
// action validates it again (defense-in-depth — the engine spawn would
// also refuse) and calls setTableAccess(), which invalidates the running
// container so the next agent request boots with the new YAML.
//
// State model: keep tables as an ordered array internally so add/remove/
// reorder work naturally. We serialize back to a Record<string,level>
// at submit time. Duplicate names are caught client-side AND on the
// server; the client message is just a UX nicety.

import { useState, useTransition } from "react";

import {
  ACCESS_LEVELS,
  type AccessLevel,
  type TableAccessPolicy,
} from "@midplane-cloud/db";

import { Button } from "@/components/ui/button";

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
  const [defaultLevel, setDefaultLevel] = useState<AccessLevel>(
    initialPolicy.default,
  );
  const [rows, setRows] = useState<TableRow[]>(() =>
    Object.entries(initialPolicy.tables)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, level], i) => ({ key: `init-${i}`, name, level })),
  );
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

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

  function updateRow(key: string, patch: Partial<TableRow>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setError(null);
    setSavedAt(null);
  }

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
        setSavedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    });
  }

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
                <input
                  type="text"
                  value={r.name}
                  onChange={(e) => updateRow(r.key, { name: e.target.value })}
                  placeholder="public.users"
                  aria-label="Table name"
                  className="flex h-9 flex-1 min-w-[12rem] rounded-md border border-input bg-background px-3 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
          Saved. New policy will take effect on the next agent request.
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save permissions"}
        </Button>
      </div>
    </form>
  );
}

const LEVEL_LABEL: Record<AccessLevel, string> = {
  deny: "Deny",
  read: "Read",
  read_write: "Read + write",
};
