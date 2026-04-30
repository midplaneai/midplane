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

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  ACCESS_LEVELS,
  type AccessLevel,
  type TableAccessPolicy,
} from "@midplane-cloud/db/policy";

import { Button } from "@/components/ui/button";

interface TableRow {
  // Stable client-side key so React doesn't reuse inputs across reorders.
  key: string;
  name: string;
  level: AccessLevel;
}

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
const SUGGESTION_LIMIT = 8;
const DEBOUNCE_MS = 150;

type ErrorReason = "credential_unavailable" | "introspection_failed" | "network";

type RowState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; query: string; tables: string[] }
  | { kind: "error"; reason: ErrorReason };

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
        setSavedAt(Date.now());
      } catch (err) {
        setError(err instanceof Error ? err.message : "Save failed");
      }
    });
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

function TableNameInput({
  value,
  onChange,
  connectionId,
  excludeNames,
}: {
  value: string;
  onChange: (v: string) => void;
  connectionId: string;
  excludeNames: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [state, setState] = useState<RowState>({ kind: "idle" });
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // Click-outside closes the dropdown. We use mousedown (not blur) so a
  // click on a suggestion fires AFTER the input's blur and still commits.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Debounced search-as-you-type. Re-runs whenever the typed value or the
  // open flag changes. AbortController + cleanup means a fast typer can't
  // race two responses — the older one is cancelled in flight. The
  // server's `cache-control: private, max-age=10` handles dedup across
  // re-focus of the same query.
  useEffect(() => {
    if (!open) return;
    const trimmed = value.trim();
    const ctl = new AbortController();
    const handle = window.setTimeout(async () => {
      // Don't blow away an existing error chip on every keystroke — a
      // transient connection error stays visible until a fetch succeeds.
      setState((prev) => (prev.kind === "error" ? prev : { kind: "loading" }));
      try {
        const url = `/api/connections/${connectionId}/tables?q=${encodeURIComponent(trimmed)}`;
        const res = await fetch(url, {
          credentials: "same-origin",
          signal: ctl.signal,
        });
        if (ctl.signal.aborted) return;
        if (!res.ok) {
          setState({ kind: "error", reason: "network" });
          return;
        }
        const body = (await res.json()) as
          | { tables: string[] }
          | { tables: []; error: ErrorReason; message?: string };
        if (ctl.signal.aborted) return;
        if ("error" in body) {
          setState({ kind: "error", reason: body.error });
          return;
        }
        setState({ kind: "loaded", query: trimmed, tables: body.tables });
      } catch {
        if (ctl.signal.aborted) return;
        setState({ kind: "error", reason: "network" });
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
      ctl.abort();
    };
  }, [value, open, connectionId]);

  const filtered =
    state.kind === "loaded"
      ? state.tables.filter((n) => !excludeNames.has(n)).slice(0, SUGGESTION_LIMIT)
      : [];
  const hasSuggestions = filtered.length > 0;

  // Reset highlight when the filtered list shrinks past the current index.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered.length, activeIdx]);

  function commit(name: string) {
    onChange(name);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (hasSuggestions) {
        setActiveIdx((i) => (i + 1) % filtered.length);
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
      if (hasSuggestions) {
        setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
      }
      return;
    }
    if (e.key === "Enter") {
      if (open && hasSuggestions && filtered[activeIdx]) {
        e.preventDefault();
        commit(filtered[activeIdx]);
      }
      return;
    }
    if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  }

  return (
    <div ref={containerRef} className="relative flex-1 min-w-[12rem]">
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActiveIdx(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="public.users"
        role="combobox"
        aria-label="Table name"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={
          open && hasSuggestions && filtered[activeIdx]
            ? `${listboxId}-${activeIdx}`
            : undefined
        }
        autoComplete="off"
        spellCheck={false}
        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      {open ? (
        <ul
          id={listboxId}
          className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover shadow-md"
          role="listbox"
        >
          <PanelContents
            state={state}
            filtered={filtered}
            activeIdx={activeIdx}
            listboxId={listboxId}
            onCommit={commit}
            onHover={setActiveIdx}
            typedQuery={value.trim()}
          />
        </ul>
      ) : null}
    </div>
  );
}

function PanelContents({
  state,
  filtered,
  activeIdx,
  listboxId,
  onCommit,
  onHover,
  typedQuery,
}: {
  state: RowState;
  filtered: string[];
  activeIdx: number;
  listboxId: string;
  onCommit: (name: string) => void;
  onHover: (i: number) => void;
  typedQuery: string;
}) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <li role="presentation" className="px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/60" />
          Searching tables…
        </span>
      </li>
    );
  }
  if (state.kind === "error") {
    return (
      <li role="presentation" className="px-3 py-2 text-xs text-[hsl(var(--warn))]">
        {errorHint(state.reason)}
      </li>
    );
  }
  if (filtered.length === 0) {
    return (
      <li role="presentation" className="px-3 py-2 text-xs text-muted-foreground">
        {state.tables.length === 0 && typedQuery.length === 0
          ? "No tables visible to this connection."
          : "No match — paste the full name to add it anyway."}
      </li>
    );
  }
  return (
    <>
      {filtered.map((name, i) => (
        <li
          key={name}
          id={`${listboxId}-${i}`}
          role="option"
          aria-selected={i === activeIdx}
          // mousedown — not click — so the input's blur doesn't race
          // the click and close the dropdown before commit fires.
          onMouseDown={(e) => {
            e.preventDefault();
            onCommit(name);
          }}
          onMouseEnter={() => onHover(i)}
          className={`cursor-pointer px-3 py-1.5 font-mono text-xs ${
            i === activeIdx ? "bg-accent text-accent-foreground" : ""
          }`}
        >
          {name}
        </li>
      ))}
    </>
  );
}

function errorHint(reason: ErrorReason): string {
  switch (reason) {
    case "credential_unavailable":
      return "Couldn't decrypt connection — type names manually.";
    case "introspection_failed":
      return "Couldn't reach DB — type names manually.";
    default:
      return "Suggestion lookup failed — type names manually.";
  }
}
