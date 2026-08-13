// What the sticky Save bar says it is about to save.
//
// One Save for the whole policy means the button has to name what changed —
// with three per-card Saves, the card you clicked was the answer. "Unsaved:
// 2 tables, a write rule" is that answer, and it also catches the case the
// three-card layout made easy to miss: an edit in a list you scrolled past.
//
// Pure + client-importable (types come from the /policy subpath only — see
// CLAUDE.md).

import {
  WRITE_CLASSES,
  type TableAccessPolicy,
  type WriteRules,
} from "@midplane-cloud/db/policy";

export interface PolicySnapshot {
  tableAccess: TableAccessPolicy;
  writeRules: WriteRules;
}

export interface PolicyChanges {
  /** The catch-all level for unlisted tables moved. */
  defaultLevel: boolean;
  /** Table entries added, removed, or re-levelled. */
  tables: number;
  /** Write classes whose rule moved. */
  writeRules: number;
}

export function diffPolicy(
  applied: PolicySnapshot,
  current: PolicySnapshot,
): PolicyChanges {
  const names = new Set([
    ...Object.keys(applied.tableAccess.tables),
    ...Object.keys(current.tableAccess.tables),
  ]);
  let tables = 0;
  for (const name of names) {
    if (applied.tableAccess.tables[name] !== current.tableAccess.tables[name]) {
      tables += 1;
    }
  }
  return {
    defaultLevel: applied.tableAccess.default !== current.tableAccess.default,
    tables,
    writeRules: WRITE_CLASSES.filter(
      (c) => applied.writeRules[c] !== current.writeRules[c],
    ).length,
  };
}

export function hasPolicyChanges(changes: PolicyChanges): boolean {
  return changes.defaultLevel || changes.tables > 0 || changes.writeRules > 0;
}

/** "Unsaved: 2 tables, a write rule". Returns null when nothing changed, so
 *  the caller can key the whole bar off one value. */
export function summarizePolicyChanges(changes: PolicyChanges): string | null {
  if (!hasPolicyChanges(changes)) return null;
  const parts: string[] = [];
  if (changes.defaultLevel) parts.push("the default");
  if (changes.tables > 0) {
    parts.push(changes.tables === 1 ? "a table" : `${changes.tables} tables`);
  }
  if (changes.writeRules > 0) {
    parts.push(
      changes.writeRules === 1
        ? "a write rule"
        : `${changes.writeRules} write rules`,
    );
  }
  return `Unsaved: ${parts.join(", ")}`;
}
