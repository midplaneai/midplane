"use client";

// Schema-introspection table-name combobox. Shared between the permission
// grid and the tenant-scope editor so operators get the same
// autocomplete experience for every "pick a table" surface.
//
// Behavior: debounced fetch against GET /api/projects/:id/tables?q=…
// (the server runs an information_schema lookup against the customer's
// own DB, KMS-decrypted server-side). 150ms debounce, AbortController
// per request so a fast typer can't race two responses. Errors surface
// as an inline hint in the dropdown — never a parent-level chip.
//
// The component accepts a Set<string> of names to exclude from
// suggestions (rows that already own that name in the parent form).
// The user can still TYPE a duplicate; the parent's submit-time check
// catches it. Filtering the suggestion list is a UX nicety, not a hard
// guard.

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

const SUGGESTION_LIMIT = 8;
const DEBOUNCE_MS = 150;

type ErrorReason = "credential_unavailable" | "introspection_failed" | "network";

type RowState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; query: string; tables: string[] }
  | { kind: "error"; reason: ErrorReason };

export interface TableNameInputProps {
  value: string;
  onChange: (v: string) => void;
  projectId: string;
  /** Database name on the project — the tables route is per-db.
   *  Omitted falls back to the route's default ("main"). */
  dbName?: string;
  excludeNames: Set<string>;
  placeholder?: string;
  ariaLabel?: string;
}

export function TableNameInput({
  value,
  onChange,
  projectId,
  dbName,
  excludeNames,
  placeholder = "public.users",
  ariaLabel = "Table name",
}: TableNameInputProps) {
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

  // Debounced search-as-you-type. AbortController per request so a fast
  // typer can't race two responses — the older one is cancelled in
  // flight. The server's `cache-control: private, max-age=10` handles
  // dedup across re-focus of the same query.
  useEffect(() => {
    if (!open) return;
    const trimmed = value.trim();
    const ctl = new AbortController();
    const handle = window.setTimeout(async () => {
      setState((prev) => (prev.kind === "error" ? prev : { kind: "loading" }));
      try {
        const url = `/api/projects/${projectId}/tables?q=${encodeURIComponent(trimmed)}${
          dbName ? `&db=${encodeURIComponent(dbName)}` : ""
        }`;
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
  }, [value, open, projectId, dbName]);

  const filtered =
    state.kind === "loaded"
      ? state.tables.filter((n) => !excludeNames.has(n)).slice(0, SUGGESTION_LIMIT)
      : [];
  const hasSuggestions = filtered.length > 0;

  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered.length, activeIdx]);

  const commit = useCallback(
    (name: string) => {
      onChange(name);
      setOpen(false);
    },
    [onChange],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      if (hasSuggestions) setActiveIdx((i) => (i + 1) % filtered.length);
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
        placeholder={placeholder}
        role="combobox"
        aria-label={ariaLabel}
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
          className="absolute left-0 top-full z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border bg-popover"
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
          ? "No tables visible to this project."
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
      return "Couldn't decrypt project — type names manually.";
    case "introspection_failed":
      return "Couldn't reach DB — type names manually.";
    default:
      return "Suggestion lookup failed — type names manually.";
  }
}
