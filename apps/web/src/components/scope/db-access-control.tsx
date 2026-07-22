"use client";

import { useRef } from "react";

// Shared three-way per-database access control: No access / Read / Write.
// Used by the OAuth consent picker (interactive agents) and the token-creation
// scope picker (headless API tokens) — both author the same mcp_scope_grants
// rows, so they share one control. A segmented set of accessible radio buttons
// using the semantic allow/warn tokens; no native-select styling drift.

export type ScopeDbAccess = "read" | "write";
export type ScopeDbState = "none" | ScopeDbAccess;

export function DbAccessControl({
  value,
  disabled,
  onChange,
  label,
}: {
  value: ScopeDbState;
  disabled?: boolean;
  onChange: (v: ScopeDbState) => void;
  /** Database name — required so every row's radiogroup announces which DB it
   *  scopes (N sibling rows with one shared name are indistinguishable to a
   *  screen reader). */
  label: string;
}) {
  const options: Array<{ v: ScopeDbState; label: string }> = [
    { v: "none", label: "No access" },
    { v: "read", label: "Read" },
    { v: "write", label: "Write" },
  ];
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIdx = options.findIndex((o) => o.v === value);

  // WAI-ARIA radiogroup: one tab stop (the checked option), arrows move both
  // focus and selection, wrapping at the ends.
  function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    let next: number;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      next = (activeIdx + 1) % options.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      next = (activeIdx + options.length - 1) % options.length;
    } else {
      return;
    }
    e.preventDefault();
    onChange(options[next]!.v);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={`Database access for ${label}`}
      className="inline-flex shrink-0 divide-x divide-border overflow-hidden border border-border"
    >
      {options.map((o, i) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(o.v)}
            onKeyDown={onKeyDown}
            className={[
              "flex items-center px-3 py-1.5 text-[13px] transition-colors disabled:opacity-50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              active
                ? o.v === "write"
                  ? "bg-warn/15 font-medium text-warn"
                  : o.v === "read"
                    ? "bg-allow/15 font-medium text-allow"
                    : "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/60",
            ].join(" ")}
          >
            {/* Always-reserved dot slot so selection doesn't shift widths; the
                dot is the non-color selected signal (matches badge dots). */}
            <span
              aria-hidden
              className={[
                "mr-1.5 inline-block h-1 w-1 rounded-full",
                active ? "bg-current" : "bg-transparent",
              ].join(" ")}
            />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
