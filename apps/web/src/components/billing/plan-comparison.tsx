import type * as React from "react";

import { Badge } from "@/components/ui/badge";
import { CAPS, PLAN_PRICING, type Plan } from "@/lib/plan";
import { cn } from "@/lib/utils";

// Free / Pro / Team comparison matrix for the /billing page. Server-rendered,
// purely presentational — it takes the current plan and highlights that column.
//
// The numeric cells are DERIVED from the CAPS map (lib/plan.ts), not retyped,
// so the table can't drift from what's actually enforced — bump a cap and the
// table follows. Price comes from PLAN_PRICING (same module). Support is the one
// row with no cap behind it: it's a service-level promise, not an entitlement,
// so it lives here as display copy. Keep it aligned with PRICING.md.

const PLAN_ORDER: readonly Plan[] = ["free", "pro", "team"];

const PLAN_LABEL: Record<Plan, string> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
};

// Service level per tier — display copy, not a code-enforced cap (see header).
const SUPPORT: Record<Plan, string> = {
  free: "Community",
  pro: "Email",
  team: "Priority email",
};

/** Infinity → "Unlimited", else the number. */
function cap(n: number): string {
  return Number.isFinite(n) ? String(n) : "Unlimited";
}

function Yes() {
  return <span className="text-foreground">✓</span>;
}

function No() {
  return <span className="text-subtle">—</span>;
}

interface Row {
  label: string;
  cell: (plan: Plan) => React.ReactNode;
}

const ROWS: readonly Row[] = [
  {
    label: "price",
    cell: (p) => (
      <span className="text-foreground">
        {PLAN_PRICING[p].amount}
        <span className="text-subtle">{PLAN_PRICING[p].period}</span>
      </span>
    ),
  },
  { label: "projects", cell: (p) => cap(CAPS[p].projects) },
  { label: "mcp tokens", cell: (p) => cap(CAPS[p].tokens) },
  { label: "seats", cell: (p) => cap(CAPS[p].seats) },
  {
    label: "audit retention",
    cell: (p) => `${CAPS[p].auditRetentionDays} days`,
  },
  { label: "sso / saml", cell: (p) => (CAPS[p].sso ? <Yes /> : <No />) },
  { label: "support", cell: (p) => SUPPORT[p] },
];

export function PlanComparison({
  currentPlan,
  ctas,
}: {
  currentPlan: Plan;
  /** Per-tier call-to-action node (upgrade / manage / "current"), resolved by
   *  the page from the billing state. A null entry renders an empty cell. */
  ctas?: Partial<Record<Plan, React.ReactNode>>;
}) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className="w-[34%] py-2" />
          {PLAN_ORDER.map((p) => {
            const current = p === currentPlan;
            return (
              <th
                key={p}
                scope="col"
                className={cn(
                  "px-3 py-2 text-center align-bottom",
                  current && "bg-[hsl(var(--brand)/0.05)]",
                )}
              >
                <div className="flex flex-col items-center gap-1">
                  <span className="text-[13px] font-medium text-foreground">
                    {PLAN_LABEL[p]}
                  </span>
                  {current && (
                    <Badge variant="accent" withDot={false}>
                      current
                    </Badge>
                  )}
                </div>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.label} className="border-b border-card last:border-0">
            <th
              scope="row"
              className="py-2 pr-4 text-left font-mono text-[11.5px] font-normal lowercase tracking-[0.04em] text-subtle"
            >
              {row.label}
            </th>
            {PLAN_ORDER.map((p) => {
              const current = p === currentPlan;
              return (
                <td
                  key={p}
                  className={cn(
                    "px-3 py-2 text-center font-mono text-[12px] tabular-nums",
                    current
                      ? "bg-[hsl(var(--brand)/0.05)] text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {row.cell(p)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
      {ctas && (
        <tfoot>
          <tr>
            <td className="pt-4" />
            {PLAN_ORDER.map((p) => {
              const current = p === currentPlan;
              return (
                <td
                  key={p}
                  className={cn(
                    "px-3 pb-1 pt-4 align-top",
                    current && "bg-[hsl(var(--brand)/0.05)]",
                  )}
                >
                  {ctas[p] ?? null}
                </td>
              );
            })}
          </tr>
        </tfoot>
      )}
    </table>
  );
}
