"use client";

// The Database pane's policy: two lists, one Save.
//
// Table access answers "which tables", write rules answer "what a write may
// do". They were three cards with three descriptions and three Save buttons,
// which made one intent ("let this agent fix orders, but ask me before schema
// changes") into three saves, three engine pushes, and three chances to walk
// away half-applied. Here the pane holds the whole draft and commits it once.
//
// The Save bar appears only when dirty and names what changed, because with one
// button the click no longer says which list you touched.

import { useState, useTransition } from "react";

import {
  type AccessLevel,
  type TableAccessPolicy,
  type WriteRules,
} from "@midplane-cloud/db/policy";

import {
  TableAccessList,
  policyToRows,
  rowsToPolicy,
  type TableRow,
} from "@/components/projects/table-access-list";
import {
  WriteRulesList,
  rulesAskForApproval,
} from "@/components/projects/write-rules-list";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import {
  diffPolicy,
  hasPolicyChanges,
  summarizePolicyChanges,
} from "@/lib/policy-diff";

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/;

export type SaveResult = { ok: true } | { ok: false; error: string };

export function PolicyEditor({
  projectId,
  dbName,
  initialPolicy,
  initialRules,
  action,
  approvalsConfigured = true,
}: {
  projectId: string;
  dbName: string;
  initialPolicy: TableAccessPolicy;
  initialRules: WriteRules;
  /** Saves both lists in one write. Returns state rather than throwing: a
   *  duplicate table name or an engine rejection is a user-recoverable error
   *  that belongs next to the button, not in a runtime overlay. */
  action: (next: {
    tableAccess: TableAccessPolicy;
    writeRules: WriteRules;
  }) => Promise<SaveResult>;
  approvalsConfigured?: boolean;
}) {
  // `applied` is what the server currently holds — the baseline for the dirty
  // check. It shifts to whatever we just saved on success, so the bar settles
  // without waiting for the server component to re-render.
  const [applied, setApplied] = useState({
    tableAccess: initialPolicy,
    writeRules: initialRules,
  });
  const [defaultLevel, setDefaultLevel] = useState<AccessLevel>(
    initialPolicy.default,
  );
  const [rows, setRows] = useState<TableRow[]>(() => policyToRows(initialPolicy));
  const [rules, setRules] = useState<WriteRules>(initialRules);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const current = {
    tableAccess: rowsToPolicy(defaultLevel, rows),
    writeRules: rules,
  };
  const changes = diffPolicy(applied, current);
  const dirty = hasPolicyChanges(changes);
  // Choosing Ask on a deployment with no gate would leave the engine holding
  // writes nobody can answer. The server refuses the save too; blocking here
  // means the user isn't told after the fact.
  const blockedOnGate = !approvalsConfigured && rulesAskForApproval(rules);

  function edit<T>(setter: (v: T) => void) {
    return (v: T) => {
      setError(null);
      setter(v);
    };
  }

  function handleSave() {
    setError(null);

    // Pre-flight matching the server's validator, for a better message. The
    // server re-validates, and so does the engine.
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

    const next = {
      tableAccess: rowsToPolicy(defaultLevel, trimmed),
      writeRules: rules,
    };
    startTransition(async () => {
      const result = await action(next);
      if (result.ok) {
        setApplied(next);
      } else {
        setError(result.error);
      }
    });
  }

  function handleDiscard() {
    setDefaultLevel(applied.tableAccess.default);
    setRows(policyToRows(applied.tableAccess));
    setRules(applied.writeRules);
    setError(null);
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <SectionLabel>Table access</SectionLabel>
        <TableAccessList
          defaultLevel={defaultLevel}
          rows={rows}
          onDefaultChange={edit(setDefaultLevel)}
          onRowsChange={edit(setRows)}
          projectId={projectId}
          dbName={dbName}
        />
      </section>

      <section className="space-y-3">
        <SectionLabel>What a write may do</SectionLabel>
        <WriteRulesList
          rules={rules}
          onChange={edit(setRules)}
          approvalsConfigured={approvalsConfigured}
        />
      </section>

      {/* Sticky, because the two lists are longer than a viewport and a Save
          you have to scroll to find is one you forget to press. Only rendered
          when dirty, so a pane you're only reading has no bar at all. */}
      {dirty || error ? (
        <div
          className="sticky bottom-4 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border-strong bg-card px-4 py-3 shadow-lg"
          data-testid="policy-save-bar"
        >
          {/* role="status" on the text, not the bar: a live region wrapping the
              buttons would re-announce them on every keystroke. */}
          <div className="min-w-0 flex-1" role="status">
            {error ? (
              <p className="text-xs text-destructive" data-testid="policy-error">
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                <span className="text-foreground">
                  {summarizePolicyChanges(changes)}
                </span>{" "}
                · applies to the next request
              </p>
            )}
          </div>
          {dirty && !pending ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleDiscard}
              data-testid="policy-discard"
            >
              Discard
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={pending || !dirty || blockedOnGate}
            onClick={handleSave}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
