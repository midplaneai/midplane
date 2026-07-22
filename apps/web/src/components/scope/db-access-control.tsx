"use client";

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
  /** Database name, so each row's radiogroup announces which DB it scopes. */
  label?: string;
}) {
  const options: Array<{ v: ScopeDbState; label: string }> = [
    { v: "none", label: "No access" },
    { v: "read", label: "Read" },
    { v: "write", label: "Write" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label={label ? `Database access for ${label}` : "Database access"}
      className="inline-flex divide-x divide-border overflow-hidden border border-border"
    >
      {options.map((o) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.v)}
            className={[
              "flex items-center px-3 py-1.5 text-[13px] transition-colors disabled:opacity-50",
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
