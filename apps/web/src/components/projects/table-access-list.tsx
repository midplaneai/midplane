"use client";

// "Table access" — which tables an agent may reach, and at what level.
//
// Tables are rows, levels are columns, and the catch-all for everything you
// didn't list is the pinned top row, so the default and the overrides pick a
// level the same way. Controlled: the pane owns the state and saves once, so
// this component has no form, no Save, and no opinion about when a change
// lands. (It used to own all three — see the pane's single sticky Save.)
//
// Autocomplete: each row owns its own debounced fetch against
// GET /api/projects/:id/tables?q=<substring>, an information_schema lookup
// against the customer's own DB (KMS-decrypted server-side).

import { useCallback } from "react";

import {
  ACCESS_LEVELS,
  type AccessLevel,
  type TableAccessPolicy,
} from "@midplane-cloud/db/policy";

import { Button } from "@/components/ui/button";
import { TableNameInput } from "@/components/table-name-input";
import {
  PolicySegment,
  type SegmentTone,
} from "@/components/projects/policy-segment";
import { cn } from "@/lib/utils";

const GRID_COLS =
  "grid grid-cols-[minmax(11rem,1.5fr)_repeat(3,minmax(6rem,1fr))_2.75rem] items-stretch";

export interface TableRow {
  /** Stable client-side key so React doesn't reuse inputs across reorders. It
   *  is ALSO rendered into each radio's `name` (groupName), so it must be
   *  deterministic across server and client renders — see policyToRows. */
  key: string;
  name: string;
  level: AccessLevel;
}

// Source case is canonical (Title Case); DESIGN.md's voice split is handled by
// the label text itself, so a screen reader announces "Read + write".
const LEVEL_LABEL: Record<AccessLevel, string> = {
  deny: "Deny",
  read: "Read",
  read_write: "Read + write",
};

// Strictest left, same ramp as the write rules beside it.
const LEVEL_TONE: Record<AccessLevel, SegmentTone> = {
  deny: "restrictive",
  read: "moderate",
  read_write: "permissive",
};

export function TableAccessList({
  defaultLevel,
  rows,
  onDefaultChange,
  onRowsChange,
  projectId,
  dbName,
}: {
  defaultLevel: AccessLevel;
  rows: TableRow[];
  onDefaultChange: (level: AccessLevel) => void;
  onRowsChange: (rows: TableRow[]) => void;
  projectId: string;
  /** Scopes the autocomplete's introspection to the right DB. */
  dbName?: string;
}) {
  const updateRow = useCallback(
    (key: string, patch: Partial<TableRow>) => {
      onRowsChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    },
    [rows, onRowsChange],
  );

  // Names already chosen in OTHER rows, so a row's dropdown doesn't suggest a
  // name that's taken elsewhere. A row keeps its own name in the list; the
  // duplicate check at save time is what actually catches collisions.
  const usedNames = new Set(rows.map((r) => r.name).filter((n) => n.length > 0));

  return (
    <div className="space-y-3">
      <div
        className="border border-border"
        role="group"
        aria-label="Table access"
      >
        {/* Default row — the catch-all, pinned at the top and held on --card
            so it reads as the fallback. No header band: every segment is
            labeled, so the first row doubles as the legend. Its label is prose,
            not an identifier, so it stays in Geist while real table names below
            are mono.

            "All other tables", not "Every other table": the latter reads as
            *alternate* tables as readily as *remaining* ones, and this row sets
            the level for anything the rows below don't name. */}
        <div
          className={cn(GRID_COLS, "border-b-2 border-border bg-card")}
          role="radiogroup"
          aria-label="Access for all other tables"
        >
          <div className="flex items-center px-2 py-1">
            <span className="flex h-9 items-center px-3 text-sm text-muted-foreground">
              All other tables
            </span>
          </div>
          {ACCESS_LEVELS.map((level) => (
            <PolicySegment
              key={level}
              label={LEVEL_LABEL[level]}
              tone={LEVEL_TONE[level]}
              selected={defaultLevel === level}
              groupName="default-level"
              rowLabel="All other tables"
              onSelect={() => onDefaultChange(level)}
            />
          ))}
          <div className="border-l border-border" aria-hidden />
        </div>

        {rows.map((r) => {
          const label = r.name.trim() || "new table";
          return (
            <div
              key={r.key}
              className={cn(GRID_COLS, "border-b border-border last:border-b-0")}
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
                <PolicySegment
                  key={level}
                  label={LEVEL_LABEL[level]}
                  tone={LEVEL_TONE[level]}
                  selected={r.level === level}
                  groupName={`level-${r.key}`}
                  rowLabel={label}
                  onSelect={() => updateRow(r.key, { level })}
                />
              ))}
              <div className="flex items-center justify-center border-l border-border">
                <button
                  type="button"
                  onClick={() =>
                    onRowsChange(rows.filter((row) => row.key !== r.key))
                  }
                  aria-label={`Remove ${label}`}
                  className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onRowsChange([
            ...rows,
            // Timestamp keys are safe here: these rows are created by a
            // post-hydration click, so they have no server render to disagree
            // with (unlike policyToRows below).
            { key: `new-${Date.now()}-${rows.length}`, name: "", level: "read" },
          ])
        }
      >
        + Add table
      </Button>
    </div>
  );
}

export function policyToRows(policy: TableAccessPolicy): TableRow[] {
  return (
    Object.entries(policy.tables)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      // Deterministic key by index — NOT Date.now(). This runs on both the
      // server render and the client hydration, and the key is rendered into
      // the radio `name`; a timestamp would differ between the two and produce
      // a hydration mismatch. The index is stable for the initial rows and
      // independent of the editable table name (so typing doesn't remount the
      // input).
      .map(([name, level], i) => ({ key: `init-${i}`, name, level }))
  );
}

/** Lenient rows → policy, for the dirty check. Skips empty placeholder rows so
 *  a half-typed name doesn't mark the pane dirty before the user finishes. */
export function rowsToPolicy(
  defaultLevel: AccessLevel,
  rows: TableRow[],
): TableAccessPolicy {
  return {
    default: defaultLevel,
    tables: rows.reduce<Record<string, AccessLevel>>((acc, r) => {
      const name = r.name.trim();
      if (name) acc[name] = r.level;
      return acc;
    }, {}),
  };
}
