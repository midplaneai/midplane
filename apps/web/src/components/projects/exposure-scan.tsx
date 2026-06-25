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
  type IgnoredColumnsConfig,
  type MaskRule,
  type MaskTransformKind,
  type PseudonymizeKind,
} from "@midplane-cloud/db/policy";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  // `idle` is the pre-scan state: introspection hits the live DB, so we don't
  // run it on mount — the user clicks "Scan" (design D1, on-demand).
  | { kind: "idle" }
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
  /** User dismissed this column as not-PII (scan-view only). */
  ignored: boolean;
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

const addInputClass =
  "w-44 rounded-none border border-input bg-background px-2 py-1 font-mono text-[11px] text-foreground placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-[hsl(var(--ring))]";

// Plain-language meaning of a match's confidence — surfaced on hover so the
// scan never makes the user guess what a level means. The chip itself drops the
// inline level word (it lengthened the weakest matches and drew the eye to the
// least-certain rows); confidence now recedes here instead.
const CONFIDENCE_TOOLTIP: Record<PiiMatch["confidence"], string> = {
  high: "Strong match — the column name clearly indicates personal data.",
  medium: "Likely — the column name suggests personal data.",
  low: "Weak match — based on the column name only; may not be personal data.",
};

// The "detected" chip. Every category renders at the SAME weight (the category
// alone, no trailing level word), so a weak `name` no longer outshouts a strong
// `email`. Confidence instead recedes: `high` keeps the solid dot, `medium`/`low`
// go dot-less and dimmed. The level's meaning lives in the hover tooltip.
function DetectedBadge({
  category,
  confidence,
}: {
  category: string;
  confidence: PiiMatch["confidence"];
}) {
  const strong = confidence === "high";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex cursor-default">
          <Badge
            variant="warn"
            withDot={strong}
            className={strong ? undefined : "opacity-60"}
          >
            {category}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent>{CONFIDENCE_TOOLTIP[confidence]}</TooltipContent>
    </Tooltip>
  );
}

export function ExposureScan({
  projectId,
  db,
  maskingConfigured,
  initialMasks,
  initialIgnored,
  onSave,
  onSaveIgnored,
}: {
  projectId: string;
  db: string;
  /** Whether MIDPLANE_MASK_SALT_MASTER is set on this deployment. When false the
   *  engine refuses to spawn with any mask, so we surface it loudly + disable the
   *  mask controls rather than let a save break the project's agent later. */
  maskingConfigured: boolean;
  initialMasks: ColumnMasks;
  initialIgnored: IgnoredColumnsConfig;
  onSave: (masks: ColumnMasks) => Promise<SaveResult>;
  onSaveIgnored: (ignored: IgnoredColumnsConfig) => Promise<SaveResult>;
}) {
  // Seed from persisted state so masked + dismissed columns render (and stay
  // manageable) with NO scan run; the scan only adds the live "exposed" rows.
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  const [masks, setMasks] = useState<ColumnMasks>(initialMasks);
  const [ignored, setIgnored] = useState<IgnoredColumnsConfig>(initialIgnored);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [showDismissed, setShowDismissed] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addTable, setAddTable] = useState("");
  const [addColumn, setAddColumn] = useState("");

  // On-demand: introspection hits the live DB, so we only run on an explicit
  // click (initial state is `idle`). Switching DB remounts (parent `key`), so
  // this resets cleanly without a stale auto-fetch.
  function runScan() {
    setScan({ kind: "loading" });
    setSaveError(null);
    // no-store: the response bundles the DB's CURRENT masks + dismissals, which
    // the user mutates via separate save actions. A cached replay (the endpoint
    // used to advertise max-age) would clobber just-saved state on rescan and
    // make a masked/dismissed column reappear. Each rescan wants live truth.
    fetch(`/api/projects/${projectId}/scan?db=${encodeURIComponent(db)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((body) => {
        if (body?.error) {
          setScan({
            kind: "error",
            message:
              body.error === "credential_unavailable"
                ? "Couldn't reach the database — its credential is temporarily unavailable. Retry in a moment."
                : "Couldn't read the schema. Check the database is reachable and retry.",
          });
          return;
        }
        setScan({ kind: "ok", columns: body.columns ?? [], scannedColumns: body.scannedColumns ?? 0 });
        setMasks(body.columnMasks ?? {});
        setIgnored(body.ignoredColumns ?? {});
      })
      .catch(() => {
        setScan({ kind: "error", message: "Scan request failed. Retry shortly." });
      });
  }

  // Optimistically apply `next`, persist, and revert on failure. Masks and
  // dismissals are independent JSONB columns with independent save actions, so
  // each has its own optimistic state + revert.
  function commitMasks(next: ColumnMasks) {
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
  function commitIgnored(next: IgnoredColumnsConfig) {
    const prev = ignored;
    setIgnored(next);
    setSaveError(null);
    startTransition(async () => {
      const res = await onSaveIgnored(next);
      if (!res.ok) {
        setIgnored(prev);
        setSaveError(res.error);
      }
    });
  }

  function setMask(table: string, column: string, rule: MaskRule) {
    commitMasks({ ...masks, [table]: { ...(masks[table] ?? {}), [column]: rule } });
  }
  function unmask(table: string, column: string) {
    const tableMasks = { ...(masks[table] ?? {}) };
    delete tableMasks[column];
    const next = { ...masks };
    if (Object.keys(tableMasks).length === 0) delete next[table];
    else next[table] = tableMasks;
    commitMasks(next);
  }
  function ignore(table: string, column: string) {
    const list = ignored[table] ?? [];
    if (list.includes(column)) return;
    commitIgnored({ ...ignored, [table]: [...list, column] });
  }
  function restore(table: string, column: string) {
    const list = (ignored[table] ?? []).filter((c) => c !== column);
    const next = { ...ignored };
    if (list.length === 0) delete next[table];
    else next[table] = list;
    commitIgnored(next);
  }
  function addCustom() {
    const t = addTable.trim();
    const c = addColumn.trim();
    if (!t || !c) return;
    // Universal type-safe default; the user refines via the transform editor on
    // the masked row that appears (an unknown-type column leaves every kind on).
    setMask(t, c, "null-out");
    setShowAdd(false);
    setAddTable("");
    setAddColumn("");
  }

  // The masked + dismissed lists come from persisted state and need NO scan;
  // only the EXPOSED (warn) rows require live introspection. So the scan is a
  // control at the top, not a gate on the whole surface — masked columns stay
  // visible and editable in every scan state (idle / loading / error).
  const scanColumns = scan.kind === "ok" ? scan.columns : [];
  const rows = mergeRows(scanColumns, masks, ignored);
  const maskedRows = rows.filter((r) => r.masked !== null);
  const exposedRows = rows.filter(
    (r) => r.masked === null && !r.ignored && r.category !== null,
  );
  const dismissedRows = rows.filter((r) => r.masked === null && r.ignored);
  // Masked-first, then the still-exposed action items (each group already sorted
  // by table → column). The detected badge keeps the two visually distinct.
  const tableRows = [...maskedRows, ...exposedRows];
  const showMeta =
    scan.kind === "ok" || maskedRows.length > 0 || dismissedRows.length > 0;
  // Masking is unenforceable without the deployment salt — block ADDING masks
  // (mask / add-column / change-transform) but keep removals (unmask) so a stuck
  // project can recover. Dismiss/restore are scan-view state, unaffected.
  const maskDisabled = pending || !maskingConfigured;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-4">
        {!maskingConfigured ? (
          <div
            className={
              maskedRows.length > 0
                ? "rounded-lg border border-[hsl(var(--deny)/0.4)] bg-[hsl(var(--deny)/0.06)] px-3.5 py-2.5 text-xs text-[hsl(var(--deny))]"
                : "rounded-lg border border-border border-l-2 border-l-[hsl(var(--warn))] bg-card px-3.5 py-2.5 text-xs text-muted-foreground"
            }
          >
            <p>
              <strong className="font-medium">
                Masking isn&apos;t configured on this deployment.
              </strong>{" "}
              {maskedRows.length > 0 ? (
                <>
                  The {maskedRows.length} masked column
                  {maskedRows.length === 1 ? "" : "s"} below won&apos;t be enforced
                  — the engine refuses to start with masks set until{" "}
                  <code className="font-mono">MIDPLANE_MASK_SALT_MASTER</code> is
                  set. Set it, or unmask to restore the connection.
                </>
              ) : (
                <>
                  Set <code className="font-mono">MIDPLANE_MASK_SALT_MASTER</code>{" "}
                  to turn on masking — deterministic transforms need a
                  per-deployment salt, so masks can&apos;t be saved until it&apos;s
                  configured.
                </>
              )}
            </p>
          </div>
        ) : null}
        <header className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              {scan.kind === "error" ? (
                <div className="rounded-lg border border-[hsl(var(--warn)/0.4)] bg-card px-3.5 py-2.5">
                  <p className="text-sm text-muted-foreground">{scan.message}</p>
                </div>
              ) : scan.kind === "loading" ? (
                <p className="text-sm text-muted-foreground">
                  Scanning <code className="font-mono">information_schema</code>…
                </p>
              ) : scan.kind === "ok" ? (
                exposedRows.length > 0 ? (
                  <p className="text-sm text-muted-foreground">
                    <strong className="font-medium text-foreground">
                      {exposedRows.length} column{exposedRows.length === 1 ? "" : "s"}
                    </strong>{" "}
                    your agent can read look like personal data.
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    <strong className="font-medium text-foreground">
                      No exposed personal data detected.
                    </strong>{" "}
                    Nothing the scan recognizes as PII is readable unmasked.
                  </p>
                )
              ) : (
                <p className="text-sm text-muted-foreground">
                  Scan to find columns your agent can read that look like personal
                  data. Reads <code className="font-mono">information_schema</code>{" "}
                  only — never row values.
                </p>
              )}
            </div>
            <div className="shrink-0">
              {scan.kind === "loading" ? (
                <Button size="sm" disabled>
                  Scanning…
                </Button>
              ) : scan.kind === "idle" ? (
                <Button size="sm" disabled={pending} onClick={runScan}>
                  Scan for exposed columns
                </Button>
              ) : (
                <Button variant="outline" size="sm" disabled={pending} onClick={runScan}>
                  {scan.kind === "error" ? "Retry scan" : "Rescan"}
                </Button>
              )}
            </div>
          </div>
          {showMeta ? (
            <p className="font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
              {scan.kind === "ok" ? `scanned ${scan.scannedColumns} columns · ` : ""}
              {maskedRows.length} masked
              {dismissedRows.length > 0 ? ` · ${dismissedRows.length} dismissed` : ""}
              {pending ? " · saving…" : ""}
            </p>
          ) : null}
          {saveError ? (
            <p className="text-xs text-[hsl(var(--deny))]">Couldn&apos;t save: {saveError}</p>
          ) : null}
        </header>

        {tableRows.length > 0 ? (
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
                {tableRows.map((r) => (
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
                        <DetectedBadge category={r.category} confidence={r.confidence ?? "high"} />
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5">
                      {r.masked !== null ? (
                        <TransformEditor
                          value={r.masked}
                          dataType={r.dataType}
                          disabled={maskDisabled}
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
                          Unmask
                        </Button>
                      ) : r.category !== null ? (
                        <div className="flex items-center justify-end gap-1.5">
                          {r.suggested ? (
                            <Button
                              size="sm"
                              disabled={maskDisabled}
                              title={
                                !maskingConfigured
                                  ? "Masking isn’t configured (set MIDPLANE_MASK_SALT_MASTER)"
                                  : undefined
                              }
                              onClick={() => setMask(r.table, r.column, r.suggested!)}
                            >
                              Mask
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={pending}
                            title="Not personal data — stop flagging this column"
                            onClick={() => ignore(r.table, r.column)}
                          >
                            Ignore
                          </Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <div>
          {showAdd ? (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card px-3.5 py-3">
              <label className="flex flex-col gap-1 font-mono text-[11px] text-subtle">
                table
                <input
                  className={addInputClass}
                  placeholder="public.users"
                  value={addTable}
                  disabled={pending}
                  aria-label="table to mask"
                  onChange={(e) => setAddTable(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 font-mono text-[11px] text-subtle">
                column
                <input
                  className={addInputClass}
                  placeholder="email"
                  value={addColumn}
                  disabled={pending}
                  aria-label="column to mask"
                  onChange={(e) => setAddColumn(e.target.value)}
                />
              </label>
              <Button
                size="sm"
                disabled={maskDisabled || !addTable.trim() || !addColumn.trim()}
                onClick={addCustom}
              >
                Add
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setShowAdd(false);
                  setAddTable("");
                  setAddColumn("");
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={maskDisabled}
              title={
                !maskingConfigured
                  ? "Masking isn’t configured (set MIDPLANE_MASK_SALT_MASTER)"
                  : undefined
              }
              onClick={() => setShowAdd(true)}
            >
              + Add a column to mask
            </Button>
          )}
          <p className="mt-1.5 text-xs text-subtle">
            Mask a column the scan didn&apos;t flag — an off-pattern name, or data
            inside a JSON column.
          </p>
        </div>

        {dismissedRows.length > 0 ? (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowDismissed((v) => !v)}
              className="font-mono text-[11px] lowercase tracking-[0.04em] text-subtle hover:text-foreground"
            >
              {showDismissed ? "▾" : "▸"} dismissed ({dismissedRows.length})
            </button>
            {showDismissed ? (
              <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <table className="w-full border-collapse">
                  <tbody>
                    {dismissedRows.map((r) => (
                      <tr key={`${r.table}.${r.column}`} className="border-b border-card last:border-0">
                        <td className="px-3.5 py-2 font-mono text-xs text-subtle">
                          {r.table}.{r.column}
                        </td>
                        <td className="px-3.5 py-2 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={pending}
                            onClick={() => restore(r.table, r.column)}
                          >
                            Restore
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}

        <p className="rounded-lg border border-border border-l-2 border-l-[hsl(var(--warn))] bg-card px-3.5 py-2.5 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Masking redacts results — it doesn&apos;t make the data secret.</strong>{" "}
          A masked column is reliably replaced in what the agent reads back, but the agent can still
          filter or sort on the real value (<span className="font-mono">where email = …</span>) to infer it.
        </p>
      </div>
    </TooltipProvider>
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

// Unify the heuristic scan with the persisted masks + dismissals: every flagged
// column, every masked column (even if not flagged), and every dismissed column
// (so it can be restored), sorted by table then column. A masked column wins
// over a dismissal — masking supersedes "not PII" — so `ignored` only sticks on
// an unmasked row.
function mergeRows(
  columns: ScannedColumn[],
  masks: ColumnMasks,
  ignored: IgnoredColumnsConfig,
): Row[] {
  const ignoredSet = new Set<string>();
  for (const [table, cols] of Object.entries(ignored)) {
    for (const column of cols) ignoredSet.add(`${table}.${column}`);
  }
  const byKey = new Map<string, Row>();
  for (const c of columns) {
    const key = `${c.table}.${c.column}`;
    byKey.set(key, {
      table: c.table,
      column: c.column,
      dataType: c.dataType,
      category: c.match.category,
      confidence: c.match.confidence,
      masked: masks[c.table]?.[c.column] ?? null,
      ignored: ignoredSet.has(key),
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
          ignored: ignoredSet.has(key),
          suggested: null,
        });
    }
  }
  // Dismissed columns the scan no longer flags (and that aren't masked) still
  // need a row so the user can restore them.
  for (const [table, cols] of Object.entries(ignored)) {
    for (const column of cols) {
      const key = `${table}.${column}`;
      if (!byKey.has(key))
        byKey.set(key, {
          table,
          column,
          dataType: "",
          category: null,
          confidence: null,
          masked: null,
          ignored: true,
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
