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
}: {
  value: ScopeDbState;
  disabled?: boolean;
  onChange: (v: ScopeDbState) => void;
}) {
  const options: Array<{ v: ScopeDbState; label: string }> = [
    { v: "none", label: "No access" },
    { v: "read", label: "Read" },
    { v: "write", label: "Write" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Database access"
      className="inline-flex overflow-hidden border border-border"
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
              "px-2.5 py-1 text-xs transition-colors disabled:opacity-50",
              active
                ? o.v === "write"
                  ? "bg-warn/15 font-medium text-warn"
                  : o.v === "read"
                    ? "bg-allow/15 font-medium text-allow"
                    : "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/60",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
