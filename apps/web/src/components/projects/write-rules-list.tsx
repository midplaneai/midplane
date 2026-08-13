"use client";

// "What a write may do" — three statement classes, one rule each.
//
// This is the list that used to be two cards and a switch: a Guardrails card
// with block/allow, an Approvals card with run/approve, and a paragraph
// explaining that guardrails beat approvals. Refuse / Ask / Allow says all of
// it in one control, because refuse and ask are now values of the same rule and
// therefore cannot be set at once — the precedence has nothing left to
// arbitrate.
//
// Conventional term leads; the SQL it stands for is the sub-label. Someone
// deciding whether an agent may drop a table should not have to read
// "block_ddl" to find the row.

import type { WriteClass, WriteRules, WriteRuleValue } from "@midplane-cloud/db/policy";

import {
  PolicySegment,
  type SegmentTone,
} from "@/components/projects/policy-segment";
import { cn } from "@/lib/utils";

const GRID_COLS =
  "grid grid-cols-[minmax(13rem,2fr)_repeat(3,minmax(5.5rem,1fr))] items-stretch";

// SQL keywords UPPERCASE against lowercase prose — all-lowercase made "with no
// where" read as English ("nowhere"), hiding that WHERE is the missing clause.
// Keywords are codes, the same carve-out DESIGN.md gives EU/US and badge text.
const ROWS: Array<{ key: WriteClass; label: string; sql: string }> = [
  {
    key: "row_changes",
    label: "Row changes",
    sql: "INSERT / UPDATE / DELETE with a WHERE clause",
  },
  {
    key: "whole_table_writes",
    label: "Whole-table writes",
    sql: "DELETE / UPDATE with no WHERE",
  },
  {
    key: "schema_changes",
    label: "Schema changes",
    sql: "DROP / TRUNCATE / ALTER",
  },
];

// Same ramp as Table access: strictest left.
const VALUES: Array<{ value: WriteRuleValue; label: string; tone: SegmentTone }> =
  [
    { value: "refuse", label: "Refuse", tone: "restrictive" },
    { value: "ask", label: "Ask", tone: "moderate" },
    { value: "allow", label: "Allow", tone: "permissive" },
  ];

export function WriteRulesList({
  rules,
  onChange,
  approvalsConfigured = true,
}: {
  rules: WriteRules;
  onChange: (next: WriteRules) => void;
  /** Whether this deployment can actually ask anyone (approval secret +
   *  origin). Without them the engine has no gate, so every held write would be
   *  refused and nothing would reach the queue — the save is refused server-side
   *  too, but learning it here beats learning it from a rejected save. */
  approvalsConfigured?: boolean;
}) {
  return (
    <div className="space-y-3">
      <div
        className="border border-border"
        role="group"
        aria-label="What a write may do"
      >
        {ROWS.map(({ key, label, sql }) => (
          <div
            key={key}
            className={cn(GRID_COLS, "border-b border-border last:border-b-0")}
            role="radiogroup"
            aria-label={label}
            data-testid="write-rule-row"
          >
            <div className="flex flex-col justify-center px-3 py-2">
              <span className="text-sm text-foreground">{label}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {sql}
              </span>
            </div>
            {VALUES.map(({ value, label: valueLabel, tone }) => (
              <PolicySegment
                key={value}
                label={valueLabel}
                tone={tone}
                selected={rules[key] === value}
                groupName={`write-rule-${key}`}
                rowLabel={label}
                onSelect={() => onChange({ ...rules, [key]: value })}
              />
            ))}
          </div>
        ))}
      </div>

      {!approvalsConfigured && (
        <p className="border-l-[3px] border-warn bg-warn/[0.06] px-3 py-2 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">
            This deployment has no approval service configured.
          </strong>{" "}
          Set <code className="font-mono">MIDPLANE_APPROVAL_SECRET</code> and{" "}
          <code className="font-mono">MIDPLANE_APP_ORIGIN</code> before choosing
          Ask — without them the engine has no way to ask anyone, so every held
          write would be refused and nothing would appear in the queue.
        </p>
      )}

    </div>
  );
}

/** Whether any class asks for a human — the gate-configured pre-flight. */
export function rulesAskForApproval(rules: WriteRules): boolean {
  return Object.values(rules).some((v) => v === "ask");
}
