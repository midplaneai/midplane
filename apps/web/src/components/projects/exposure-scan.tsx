"use client";

// PII exposure scan view (design D1 + D3 write). "The columns your agent can
// read that look like personal data" — and one-click masking from the same
// surface. The scan is read-only schema introspection (name+type heuristics, no
// customer row values); the mask actions write column_masks via the server
// action and force the engine to respawn with the new masks on the next request.
//
// Calibrated to DESIGN.md: table-first, lowercase-mono headers, semantic `warn`
// for an exposed column and `allow` for a masked one (no fourth color), hairlines
// not shadows, and a persistent result-redaction note. The transform editor
// type-gates each rule (partial → text, generalize → date/numeric), matching the
// engine's fail-closed input-type domains.

import { useEffect, useState, useTransition } from "react";

import {
  MASK_TRANSFORMS,
  maskRuleKind,
  maskRuleLabel,
  PSEUDONYMIZE_KINDS,
  type MaskRule,
  type MaskTransformKind,
  type PseudonymizeKind,
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

const NUMERIC_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "int",
  "int2",
  "int4",
  "int8",
  "numeric",
  "decimal",
  "real",
  "double precision",
  "float",
  "float4",
  "float8",
  "money",
]);
const isNumericType = (t: string) => NUMERIC_TYPES.has(t.toLowerCase().trim());

const DATE_TYPES = new Set([
  "date",
  "timestamp",
  "timestamp without time zone",
  "timestamp with time zone",
  "timestamptz",
]);
const isDateType = (t: string) =>
  DATE_TYPES.has(t.toLowerCase().trim()) || t.toLowerCase().startsWith("timestamp");

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

  function setMask(table: string, column: string, rule: MaskRule) {
    commit({ ...masks, [table]: { ...(masks[table] ?? {}), [column]: rule } });
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
                      <TransformEditor
                        value={r.masked}
                        dataType={r.dataType}
                        disabled={pending}
                        onChange={(rule) => setMask(r.table, r.column, rule)}
                      />
                    ) : (
                      <span className="font-mono text-[11px] text-subtle">
                        {r.suggested ? maskRuleLabel(r.suggested) : "—"}
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

const selectClass =
  "rounded-none border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]";
const numInputClass =
  "w-12 rounded-none border border-input bg-background px-1.5 py-1 font-mono text-[11px] text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]";

// The default rule when the user switches to a kind: a sensible preset whose
// params the user then tunes. generalize defaults to year on a date column and a
// 1000-width bucket on a numeric one.
function defaultRuleForKind(kind: MaskTransformKind, dataType: string): MaskRule {
  switch (kind) {
    case "full-redact":
    case "null-out":
    case "consistent-hash":
      return kind;
    case "partial":
      return { t: "partial", keepEnd: 4 };
    case "generalize":
      return isNumericType(dataType) && !isDateType(dataType)
        ? { t: "generalize", granularity: 1000 }
        : { t: "generalize", granularity: "year" };
    case "pseudonymize":
      return { t: "pseudonymize", kind: "name" };
    case "noise":
      // A modest ±10% default; non-deterministic, so the editor flags it.
      return { t: "noise", ratio: 0.1 };
  }
}

// The transform + params editor. A kind <select> (type-gated: partial → text,
// generalize → date/numeric) plus per-kind param inputs. Param inputs commit on
// change for selects and on blur for free-text/number fields (each save respawns
// the engine, so we don't persist per keystroke). An unknown column type
// (dataType === "", a masked-but-unscanned column) leaves every kind enabled.
function TransformEditor({
  value,
  dataType,
  disabled,
  onChange,
}: {
  value: MaskRule;
  dataType: string;
  disabled: boolean;
  onChange: (rule: MaskRule) => void;
}) {
  const unknownType = dataType === "";
  const textOk = unknownType || isTextType(dataType);
  const numericOk = unknownType || isNumericType(dataType);
  const dateOk = unknownType || isDateType(dataType);
  const generalizeOk = dateOk || numericOk;
  const kind = maskRuleKind(value);

  function changeKind(next: MaskTransformKind) {
    onChange(defaultRuleForKind(next, dataType));
  }

  const gateNote = (k: MaskTransformKind): string => {
    if ((k === "partial" || k === "pseudonymize") && !textOk) return " (text only)";
    if (k === "generalize" && !generalizeOk) return " (date / numeric only)";
    if (k === "noise" && !numericOk) return " (numeric only)";
    return "";
  };
  const gateDisabled = (k: MaskTransformKind): boolean =>
    ((k === "partial" || k === "pseudonymize") && !textOk) ||
    (k === "generalize" && !generalizeOk) ||
    (k === "noise" && !numericOk);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        className={selectClass}
        value={kind}
        disabled={disabled}
        aria-label="mask transform"
        onChange={(e) => changeKind(e.target.value as MaskTransformKind)}
      >
        {MASK_TRANSFORMS.map((k) => (
          <option key={k} value={k} disabled={gateDisabled(k)}>
            {k}
            {gateNote(k)}
          </option>
        ))}
      </select>

      {kind === "partial" && typeof value !== "string" && value.t === "partial" ? (
        <PartialParams value={value} disabled={disabled} onChange={onChange} />
      ) : null}

      {kind === "generalize" && typeof value !== "string" && value.t === "generalize" ? (
        <GeneralizeParams
          value={value}
          dataType={dataType}
          dateOk={dateOk}
          disabled={disabled}
          onChange={onChange}
        />
      ) : null}

      {kind === "pseudonymize" && typeof value !== "string" && value.t === "pseudonymize" ? (
        <PseudonymizeParams value={value} disabled={disabled} onChange={onChange} />
      ) : null}

      {kind === "noise" && typeof value !== "string" && value.t === "noise" ? (
        <NoiseParams value={value} disabled={disabled} onChange={onChange} />
      ) : null}
    </div>
  );
}

function PartialParams({
  value,
  disabled,
  onChange,
}: {
  value: { t: "partial"; keepStart?: number; keepEnd?: number; glyph?: string };
  disabled: boolean;
  onChange: (rule: MaskRule) => void;
}) {
  // Local drafts so typing doesn't save (and respawn) on every keystroke; commit
  // on blur. Re-sync when the persisted value changes (e.g. an optimistic revert).
  const [keepStart, setKeepStart] = useState(String(value.keepStart ?? 0));
  const [keepEnd, setKeepEnd] = useState(String(value.keepEnd ?? 0));
  const [glyph, setGlyph] = useState(value.glyph ?? "");
  useEffect(() => {
    setKeepStart(String(value.keepStart ?? 0));
    setKeepEnd(String(value.keepEnd ?? 0));
    setGlyph(value.glyph ?? "");
  }, [value.keepStart, value.keepEnd, value.glyph]);

  function commit() {
    const ks = Math.max(0, Math.floor(Number(keepStart) || 0));
    const ke = Math.max(0, Math.floor(Number(keepEnd) || 0));
    const rule: { t: "partial"; keepStart?: number; keepEnd?: number; glyph?: string } = { t: "partial" };
    if (ks > 0) rule.keepStart = ks;
    if (ke > 0) rule.keepEnd = ke;
    const g = [...glyph][0];
    if (g) rule.glyph = g;
    onChange(rule);
  }

  return (
    <span className="flex items-center gap-1 font-mono text-[11px] text-subtle">
      <label className="flex items-center gap-1">
        start
        <input
          type="number"
          min={0}
          inputMode="numeric"
          className={numInputClass}
          value={keepStart}
          disabled={disabled}
          aria-label="keep start"
          onChange={(e) => setKeepStart(e.target.value)}
          onBlur={commit}
        />
      </label>
      <label className="flex items-center gap-1">
        end
        <input
          type="number"
          min={0}
          inputMode="numeric"
          className={numInputClass}
          value={keepEnd}
          disabled={disabled}
          aria-label="keep end"
          onChange={(e) => setKeepEnd(e.target.value)}
          onBlur={commit}
        />
      </label>
      <label className="flex items-center gap-1">
        glyph
        <input
          type="text"
          maxLength={1}
          className={`${numInputClass} w-8 text-center`}
          value={glyph}
          placeholder="•"
          disabled={disabled}
          aria-label="mask glyph"
          onChange={(e) => setGlyph(e.target.value)}
          onBlur={commit}
        />
      </label>
    </span>
  );
}

function GeneralizeParams({
  value,
  dataType,
  dateOk,
  disabled,
  onChange,
}: {
  value: { t: "generalize"; granularity: "year" | "month" | "day" | number };
  dataType: string;
  dateOk: boolean;
  disabled: boolean;
  onChange: (rule: MaskRule) => void;
}) {
  // A numeric column buckets by a width; a date column truncates by a unit. When
  // the type is unknown we offer the date units (the common dob case).
  const numericMode = isNumericType(dataType) && !dateOk;
  const [width, setWidth] = useState(
    String(typeof value.granularity === "number" ? value.granularity : 1000),
  );
  useEffect(() => {
    if (typeof value.granularity === "number") setWidth(String(value.granularity));
  }, [value.granularity]);

  const commitWidth = () => {
    const w = Math.max(1, Math.floor(Number(width) || 1));
    onChange({ t: "generalize", granularity: w });
  };

  if (numericMode || typeof value.granularity === "number") {
    return (
      <label className="flex items-center gap-1 font-mono text-[11px] text-subtle">
        bucket
        <input
          type="number"
          min={1}
          inputMode="numeric"
          className={`${numInputClass} w-16`}
          value={width}
          disabled={disabled}
          aria-label="bucket width"
          onChange={(e) => setWidth(e.target.value)}
          onBlur={commitWidth}
        />
      </label>
    );
  }

  return (
    <select
      className={selectClass}
      value={value.granularity}
      disabled={disabled}
      aria-label="granularity"
      onChange={(e) =>
        onChange({ t: "generalize", granularity: e.target.value as "year" | "month" | "day" })
      }
    >
      <option value="year">year</option>
      <option value="month">month</option>
      <option value="day">day</option>
    </select>
  );
}

// pseudonymize: a kind dropdown (email / name / phone). Each kind maps to a
// compiled-in engine dictionary; the rule emits a realistic, deterministic fake.
// Text-only (gated in the kind picker). Commits on change — no draft state.
function PseudonymizeParams({
  value,
  disabled,
  onChange,
}: {
  value: { t: "pseudonymize"; kind: PseudonymizeKind };
  disabled: boolean;
  onChange: (rule: MaskRule) => void;
}) {
  return (
    <select
      className={selectClass}
      value={value.kind}
      disabled={disabled}
      aria-label="pseudonym kind"
      onChange={(e) => onChange({ t: "pseudonymize", kind: e.target.value as PseudonymizeKind })}
    >
      {PSEUDONYMIZE_KINDS.map((k) => (
        <option key={k} value={k}>
          {k}
        </option>
      ))}
    </select>
  );
}

// noise: a ±ratio input (0 < ratio ≤ 1) gated to numeric columns, plus a
// persistent `warn` badge — noise is the only NON-deterministic transform, so it
// breaks joins / grouping by design. Commits on blur (each save respawns the
// engine), like the partial inputs. Local draft re-syncs on an optimistic revert.
function NoiseParams({
  value,
  disabled,
  onChange,
}: {
  value: { t: "noise"; ratio: number };
  disabled: boolean;
  onChange: (rule: MaskRule) => void;
}) {
  const [ratio, setRatio] = useState(String(value.ratio));
  useEffect(() => {
    setRatio(String(value.ratio));
  }, [value.ratio]);

  function commit() {
    let r = Number(ratio);
    if (!Number.isFinite(r) || r <= 0) r = 0.1;
    if (r > 1) r = 1;
    onChange({ t: "noise", ratio: r });
  }

  return (
    <span className="flex items-center gap-2 font-mono text-[11px] text-subtle">
      <label className="flex items-center gap-1">
        ±ratio
        <input
          type="number"
          min={0.01}
          max={1}
          step={0.05}
          inputMode="decimal"
          className={`${numInputClass} w-14`}
          value={ratio}
          disabled={disabled}
          aria-label="noise ratio"
          onChange={(e) => setRatio(e.target.value)}
          onBlur={commit}
        />
      </label>
      <Badge variant="warn">breaks joins / grouping</Badge>
    </span>
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
    for (const [column, rule] of Object.entries(cols)) {
      const key = `${table}.${column}`;
      const existing = byKey.get(key);
      if (existing) existing.masked = rule;
      else
        byKey.set(key, {
          table,
          column,
          dataType: "",
          category: null,
          confidence: null,
          masked: rule,
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
