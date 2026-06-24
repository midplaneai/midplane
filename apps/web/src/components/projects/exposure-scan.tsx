"use client";

// PII exposure scan view (design D1 + D3 write). "The columns your agent can
// read that look like personal data" — and one-click masking from the same
// surface. The scan is read-only schema introspection (name+type heuristics, no
// customer row values); the mask actions write column_masks via the server
// action and force the engine to respawn with the new masks on the next request.
//
// Calibrated to DESIGN.md: table-first, lowercase-mono headers, semantic `warn`
// for an exposed column and `allow` for a masked one (no fourth color), hairlines
// not shadows, and a persistent result-redaction note. Each transform is gated to
// the column types it's valid for (partial/pseudonymize → text, generalize → date
// or numeric, noise → numeric), matching the engine's input domains.

import { useEffect, useState, useTransition } from "react";

import {
  MASK_TRANSFORM_KINDS,
  GENERALIZE_DATE_GRANULARITIES,
  PSEUDONYMIZE_KINDS,
  type MaskRule,
} from "@midplane-cloud/db/policy";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface PiiMatch {
  category: string;
  confidence: "high" | "medium" | "low";
  suggestedTransform: MaskRule;
}
interface ScannedColumn {
  table: string;
  column: string;
  dataType: string;
  match: PiiMatch;
}
type ColumnMasks = Record<string, Record<string, MaskRule>>;

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
  masked: MaskRule | null;
  suggested: MaskRule | null;
}

// The transform kinds the picker dropdown offers (the full catalog).
type Kind = (typeof MASK_TRANSFORM_KINDS)[number];

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

const DATE_TYPES = new Set([
  "date",
  "timestamp",
  "timestamp with time zone",
  "timestamp without time zone",
  "timestamptz",
]);
const isDateType = (t: string) => {
  const x = t.toLowerCase().trim();
  return DATE_TYPES.has(x) || x.startsWith("timestamp") || x === "date";
};

const NUMERIC_TYPES = new Set([
  "smallint", "integer", "int", "int2", "int4", "int8", "bigint",
  "numeric", "decimal", "real", "double precision", "float4", "float8", "money",
]);
const isNumericType = (t: string) => NUMERIC_TYPES.has(t.toLowerCase().trim());

// Shared mono input styling (matches the picker select).
const FIELD_CLS =
  "rounded-none border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]";

// Which transform kinds make sense for a column of this type. Presets are valid
// for every type (null-out preserves the type; full-redact/consistent-hash are
// destroy/pseudonymize rungs whose type-change is expected). The parametric
// transforms carry input domains. An unknown type ("" — a masked column not in
// the current scan) is permissive so the user is never blocked.
function offeredKindsFor(dataType: string): Kind[] {
  const unknown = dataType === "";
  const text = unknown || isTextType(dataType);
  const date = unknown || isDateType(dataType);
  const numeric = unknown || isNumericType(dataType);
  return MASK_TRANSFORM_KINDS.filter((k) => {
    if (k === "partial" || k === "pseudonymize") return text;
    if (k === "generalize") return date || numeric;
    if (k === "noise") return numeric;
    return true; // full-redact / null-out / consistent-hash
  });
}

// The kind identifier of a stored rule.
function ruleToKind(rule: MaskRule): Kind {
  return typeof rule === "string" ? rule : rule.t;
}

// A sensible default rule when the user picks a kind from the dropdown.
function defaultRuleForKind(kind: Kind, dataType: string): MaskRule {
  switch (kind) {
    case "partial":
      return { t: "partial", keepEnd: 4 };
    case "generalize":
      return isNumericType(dataType) && !isDateType(dataType)
        ? { t: "generalize", granularity: 1000 }
        : { t: "generalize", granularity: "year" };
    case "pseudonymize":
      return { t: "pseudonymize", kind: "name" };
    case "noise":
      return { t: "noise", ratio: 0.1 };
    default:
      return kind; // full-redact / null-out / consistent-hash
  }
}

// Compact human label for a rule (display-only).
function formatRule(rule: MaskRule): string {
  if (typeof rule === "string") return rule;
  switch (rule.t) {
    case "partial": {
      const bits: string[] = [];
      if (rule.keepStart) bits.push(`first ${rule.keepStart}`);
      if (rule.keepEnd) bits.push(`last ${rule.keepEnd}`);
      return bits.length ? `partial · keep ${bits.join(" + ")}` : "partial";
    }
    case "generalize":
      return `generalize · ${rule.granularity}`;
    case "pseudonymize":
      return `pseudonymize · ${rule.kind}`;
    case "noise":
      return `noise · ±${rule.ratio}`;
  }
}

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

  function setMask(table: string, column: string, transform: MaskRule) {
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
                        {r.suggested ? formatRule(r.suggested) : "—"}
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
  value: MaskRule;
  dataType: string;
  disabled: boolean;
  onChange: (t: MaskRule) => void;
}) {
  const kind = ruleToKind(value);
  const offered = offeredKindsFor(dataType);
  // The stored kind may be out-of-domain for the column type (e.g. a rule saved
  // before the type was known); keep it visible so the user can see + change it.
  const options = offered.includes(kind) ? offered : [kind, ...offered];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <select
        className={FIELD_CLS}
        value={kind}
        disabled={disabled}
        onChange={(e) => onChange(defaultRuleForKind(e.target.value as Kind, dataType))}
      >
        {options.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>
      <RuleParams value={value} dataType={dataType} disabled={disabled} onChange={onChange} />
    </div>
  );
}

// The per-transform parameter controls, rendered beside the kind dropdown when
// the selected transform is parametric. Each control edits ONE field and emits a
// fresh rule; zero/empty optional fields are omitted so the stored jsonb stays
// canonical.
function RuleParams({
  value,
  dataType,
  disabled,
  onChange,
}: {
  value: MaskRule;
  dataType: string;
  disabled: boolean;
  onChange: (t: MaskRule) => void;
}) {
  const rule = value;
  if (typeof rule === "string") return null;

  const numberField = (
    label: string,
    val: number | undefined,
    on: (n: number | undefined) => void,
    opts: { min?: number; step?: number; placeholder?: string } = {},
  ) => (
    <label className="flex items-center gap-1 font-mono text-[10px] lowercase text-subtle">
      {label}
      <input
        type="number"
        className={`${FIELD_CLS} w-14`}
        value={val ?? ""}
        min={opts.min ?? 0}
        step={opts.step ?? 1}
        placeholder={opts.placeholder}
        disabled={disabled}
        onChange={(e) => {
          const n = e.target.value === "" ? undefined : Number(e.target.value);
          on(Number.isFinite(n as number) ? (n as number) : undefined);
        }}
      />
    </label>
  );

  switch (rule.t) {
    case "partial":
      return (
        <>
          {numberField("first", rule.keepStart, (n) =>
            onChange(prunePartial({ ...rule, keepStart: n })),
          )}
          {numberField("last", rule.keepEnd, (n) =>
            onChange(prunePartial({ ...rule, keepEnd: n })),
          )}
          <label className="flex items-center gap-1 font-mono text-[10px] lowercase text-subtle">
            glyph
            <input
              type="text"
              maxLength={2}
              className={`${FIELD_CLS} w-10`}
              value={rule.glyph ?? ""}
              placeholder="•"
              disabled={disabled}
              onChange={(e) => {
                const g = [...e.target.value].slice(0, 1).join("");
                onChange(prunePartial({ ...rule, glyph: g === "" ? undefined : g }));
              }}
            />
          </label>
        </>
      );
    case "generalize": {
      const numericCol = isNumericType(dataType) && !isDateType(dataType);
      if (numericCol) {
        return numberField(
          "bucket",
          typeof rule.granularity === "number" ? rule.granularity : 1000,
          (n) => onChange({ t: "generalize", granularity: n && n > 0 ? n : 1 }),
          { min: 1, placeholder: "1000" },
        );
      }
      return (
        <select
          className={FIELD_CLS}
          value={typeof rule.granularity === "string" ? rule.granularity : "year"}
          disabled={disabled}
          onChange={(e) =>
            onChange({ t: "generalize", granularity: e.target.value as "year" })
          }
        >
          {GENERALIZE_DATE_GRANULARITIES.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      );
    }
    case "pseudonymize":
      return (
        <select
          className={FIELD_CLS}
          value={rule.kind}
          disabled={disabled}
          onChange={(e) =>
            onChange({ t: "pseudonymize", kind: e.target.value as "name" })
          }
        >
          {PSEUDONYMIZE_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      );
    case "noise":
      return (
        <>
          {numberField(
            "±ratio",
            rule.ratio,
            (n) => onChange({ t: "noise", ratio: n && n > 0 ? n : 0.1 }),
            { min: 0, step: 0.05, placeholder: "0.1" },
          )}
          <span className="font-mono text-[10px] lowercase text-[hsl(var(--warn))]">
            breaks joins
          </span>
        </>
      );
  }
}

// Drop zeroed/empty optional fields from a partial rule so { t:"partial" } is the
// canonical "mask everything" form rather than carrying keepStart:0 etc.
function prunePartial(rule: {
  t: "partial";
  keepStart?: number;
  keepEnd?: number;
  glyph?: string;
}): MaskRule {
  const out: MaskRule = { t: "partial" };
  if (rule.keepStart) out.keepStart = rule.keepStart;
  if (rule.keepEnd) out.keepEnd = rule.keepEnd;
  if (rule.glyph) out.glyph = rule.glyph;
  return out;
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
