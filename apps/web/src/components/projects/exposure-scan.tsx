"use client";

// PII exposure scan view (design D1 + D3 write). "The columns your agent can
// read that look like personal data" — and one-click masking from the same
// surface. The scan is read-only schema introspection (name+type heuristics, no
// customer row values); the mask actions write column_masks via the server
// action and force the engine to respawn with the new masks on the next request.
//
// Calibrated to DESIGN.md: table-first, lowercase-mono headers, semantic `warn`
// for an exposed column and `allow` for a masked one (no fourth color), hairlines
// not shadows, and a persistent result-redaction note. keep-last-4 is gated to
// text columns (matching the engine's text-only keep-last-4).

import { useEffect, useState, useTransition } from "react";

import { MASK_TRANSFORMS, type MaskTransform } from "@midplane-cloud/db/policy";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface PiiMatch {
  category: string;
  confidence: "high" | "medium" | "low";
  suggestedTransform: MaskTransform;
}
interface ScannedColumn {
  table: string;
  column: string;
  dataType: string;
  match: PiiMatch;
}
type ColumnMasks = Record<string, Record<string, MaskTransform>>;

type SaveResult = { ok: true } | { ok: false; error: string };

type ScanState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; columns: ScannedColumn[]; scannedColumns: number };

interface Row {
  table: string;
  column: string;
  dataType: string;
  category: string | null;
  confidence: PiiMatch["confidence"] | null;
  masked: MaskTransform | null;
  suggested: MaskTransform | null;
}

const TEXT_TYPES = new Set([
  "text",
  "character varying",
  "varchar",
  "character",
  "char",
  "citext",
  "name",
]);
const isTextType = (t: string) =>
  TEXT_TYPES.has(t.toLowerCase().trim()) || t.toLowerCase().startsWith("character");

const Th = ({ children }: { children: React.ReactNode }) => (
  <th className="px-3.5 py-2.5 text-left font-mono text-[11.5px] font-normal lowercase tracking-[0.04em] text-subtle">
    {children}
  </th>
);

export function ExposureScan({
  projectId,
  db,
  onSave,
}: {
  projectId: string;
  db: string;
  onSave: (masks: ColumnMasks) => Promise<SaveResult>;
}) {
  const [scan, setScan] = useState<ScanState>({ kind: "loading" });
  const [masks, setMasks] = useState<ColumnMasks>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    setScan({ kind: "loading" });
    fetch(`/api/projects/${projectId}/scan?db=${encodeURIComponent(db)}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        if (body?.error) {
          setScan({
            kind: "error",
            message:
              body.error === "credential_unavailable"
                ? "Couldn't reach the database — its credential is unavailable. Rotate the connection string and retry."
                : "Couldn't read the schema. Check the database is reachable and retry.",
          });
          return;
        }
        setScan({ kind: "ok", columns: body.columns ?? [], scannedColumns: body.scannedColumns ?? 0 });
        setMasks(body.columnMasks ?? {});
      })
      .catch(() => {
        if (!cancelled) setScan({ kind: "error", message: "Scan request failed. Retry shortly." });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, db]);

  // Optimistically apply `next`, persist, and revert on failure.
  function commit(next: ColumnMasks) {
    const prev = masks;
    setMasks(next);
    setSaveError(null);
    startTransition(async () => {
      const res = await onSave(next);
      if (!res.ok) {
        setMasks(prev);
        setSaveError(res.error);
      }
    });
  }

  function setMask(table: string, column: string, transform: MaskTransform) {
    commit({ ...masks, [table]: { ...(masks[table] ?? {}), [column]: transform } });
  }
  function unmask(table: string, column: string) {
    const tableMasks = { ...(masks[table] ?? {}) };
    delete tableMasks[column];
    const next = { ...masks };
    if (Object.keys(tableMasks).length === 0) delete next[table];
    else next[table] = tableMasks;
    commit(next);
  }

  if (scan.kind === "loading") {
    return (
      <p className="text-sm text-muted-foreground">
        Scanning <code className="font-mono">information_schema</code>…
      </p>
    );
  }
  if (scan.kind === "error") {
    return (
      <div className="rounded-lg border border-[hsl(var(--warn)/0.4)] bg-card p-4">
        <p className="text-sm text-muted-foreground">{scan.message}</p>
      </div>
    );
  }

  const rows = mergeRows(scan.columns, masks);
  const exposed = rows.filter((r) => r.category !== null && r.masked === null);
  const maskedCount = rows.filter((r) => r.masked !== null).length;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        {exposed.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            <strong className="font-medium text-foreground">
              {exposed.length} column{exposed.length === 1 ? "" : "s"}
            </strong>{" "}
            your agent can read look like personal data.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            <strong className="font-medium text-foreground">No exposed personal data detected.</strong>{" "}
            Nothing the scan recognizes as PII is readable unmasked.
          </p>
        )}
        <p className="font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
          scanned {scan.scannedColumns} columns · {maskedCount} masked
          {pending ? " · saving…" : ""}
        </p>
        {saveError ? (
          <p className="text-xs text-[hsl(var(--deny))]">Couldn&apos;t save: {saveError}</p>
        ) : null}
      </header>

      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <Th>column</Th>
                <Th>type</Th>
                <Th>detected</Th>
                <Th>transform</Th>
                <Th>{""}</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.table}.${r.column}`}
                  className={`border-b border-card ${r.masked === null && r.category !== null ? "bg-[hsl(var(--warn)/0.05)]" : ""}`}
                >
                  <td className="px-3.5 py-2.5 font-mono text-xs text-foreground">
                    {r.table}.{r.column}
                  </td>
                  <td className="px-3.5 py-2.5 font-mono text-xs text-subtle">{r.dataType || "—"}</td>
                  <td className="px-3.5 py-2.5">
                    {r.masked !== null ? (
                      <Badge variant="allow" withDot>masked</Badge>
                    ) : r.category !== null ? (
                      <Badge variant="warn" withDot>
                        {r.category}
                        {r.confidence && r.confidence !== "high" ? ` · ${r.confidence}` : ""}
                      </Badge>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3.5 py-2.5">
                    {r.masked !== null ? (
                      <TransformSelect
                        value={r.masked}
                        dataType={r.dataType}
                        disabled={pending}
                        onChange={(t) => setMask(r.table, r.column, t)}
                      />
                    ) : (
                      <span className="font-mono text-[11px] text-subtle">
                        {r.suggested ? `${r.suggested}` : "—"}
                      </span>
                    )}
                  </td>
                  <td className="px-3.5 py-2.5 text-right">
                    {r.masked !== null ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => unmask(r.table, r.column)}
                      >
                        unmask
                      </Button>
                    ) : r.suggested ? (
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => setMask(r.table, r.column, r.suggested!)}
                      >
                        mask
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <p className="rounded-lg border border-border border-l-2 border-l-[hsl(var(--warn))] bg-card px-3.5 py-2.5 text-xs text-muted-foreground">
        <strong className="font-medium text-foreground">Heads up:</strong> masking changes what the
        agent <em>reads back</em>. It can&apos;t hide a value the agent filters or sorts on
        (<span className="font-mono">where email = …</span>). This is result redaction, not a hard
        guarantee. Saving respawns the engine so the change takes effect on the next agent request.
      </p>
    </div>
  );
}

function TransformSelect({
  value,
  dataType,
  disabled,
  onChange,
}: {
  value: MaskTransform;
  dataType: string;
  disabled: boolean;
  onChange: (t: MaskTransform) => void;
}) {
  const textOk = dataType === "" || isTextType(dataType);
  return (
    <select
      className="rounded-none border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as MaskTransform)}
    >
      {MASK_TRANSFORMS.map((t) => (
        // keep-last-4 is text-only (engine + form gate); disable it on non-text.
        <option key={t} value={t} disabled={t === "keep-last-4" && !textOk}>
          {t}
          {t === "keep-last-4" && !textOk ? " (text only)" : ""}
        </option>
      ))}
    </select>
  );
}

// Unify the heuristic scan with the persisted masks: every flagged column plus
// every masked column (even if not flagged), sorted by table then column.
function mergeRows(columns: ScannedColumn[], masks: ColumnMasks): Row[] {
  const byKey = new Map<string, Row>();
  for (const c of columns) {
    byKey.set(`${c.table}.${c.column}`, {
      table: c.table,
      column: c.column,
      dataType: c.dataType,
      category: c.match.category,
      confidence: c.match.confidence,
      masked: masks[c.table]?.[c.column] ?? null,
      suggested: c.match.suggestedTransform,
    });
  }
  for (const [table, cols] of Object.entries(masks)) {
    for (const [column, transform] of Object.entries(cols)) {
      const key = `${table}.${column}`;
      const existing = byKey.get(key);
      if (existing) existing.masked = transform;
      else
        byKey.set(key, {
          table,
          column,
          dataType: "",
          category: null,
          confidence: null,
          masked: transform,
          suggested: null,
        });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.table === b.table
      ? a.column < b.column
        ? -1
        : a.column > b.column
          ? 1
          : 0
      : a.table < b.table
        ? -1
        : 1,
  );
}
