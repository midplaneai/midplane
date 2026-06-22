// Masking transforms — the catalog of value transforms applied to a result-set
// cell when its source column is declared masked.
//
// Design (see column-policies-masking design doc + masking-transform-catalog):
//   - DETERMINISTIC: a value-dependent transform MUST map the same input to
//     the same output every time (a join over a consistent-hashed key has to
//     still group; `partial`/`generalize` are pure functions of the value).
//     Determinism is a requirement, not a nicety.
//   - SALT-INJECTED: the salt is passed in, never read from global state, so
//     determinism is unit-testable and the salt-scope decision is a wiring
//     change, not a code change.
//   - NO RUNTIME FILE READS: everything here is pure code + node:crypto (a
//     static import). A `bun build --compile` binary does NOT embed assets read
//     at runtime via readFileSync (see learning bun-compile-readfilesync-not-
//     embedded), so a wordlist on disk would ENOENT in the shipped engine.
//   - FAIL-CLOSED: `applyTransform` is exhaustive over the MaskRule union; an
//     unrecognized rule throws (UnknownTransformError) so the masker rejects the
//     column rather than passing the real value through. This is the defense
//     against cloud↔engine version skew: a stale engine that does not know a
//     rule kind MUST deny, never leak.
//
// A mask rule is either a param-free PRESET (a bare string) or a PARAMETRIC
// transform (a tagged object). The param-free presets — full-redact, null-out,
// consistent-hash — apply to any column. The parametric transforms carry an
// input-type DOMAIN the masker enforces fail-closed (the type check lives in
// mask-result-set.ts, which has the column's pg type; an out-of-domain
// application rejects the whole result set):
//   - `partial`     text → text       (reveal a few chars, mask the rest)
//   - `generalize`  date|num → date|num (truncate a date / bucket a number)
//
// null-out is the only TYPE-PRESERVING transform — it masks to SQL NULL so a
// masked column keeps its declared Postgres type; full-redact / consistent-hash
// collapse to a text token, and `partial` / date-`generalize` change type within
// a family.
//
// NULL handling (design "v1 masking semantics"): a NULL cell stays NULL. This
// leaks "this row has no value" and is an accepted, documented limitation.
// (null-out makes NULL a transform TARGET — every value becomes NULL — which is
// distinct from this passthrough of an already-NULL input.)

import { createHmac } from "node:crypto";

/** Date-truncation unit, or a positive numeric bucket width. `year`/`month`/
 *  `day` truncate a date/timestamp; a number rounds a numeric down to a multiple
 *  of that width (e.g. 1000 → salary band). */
export type Granularity = "year" | "month" | "day" | number;

/** A declared mask rule: a param-free preset name, or a parametric transform
 *  tagged by its `t` discriminant. The cloud authors these; the engine applies
 *  them. Mirrored by the cloud's `MaskRule` (packages/db/src/policy.ts), kept in
 *  lockstep by scripts/check-mask-transforms.ts. */
export type MaskRule =
  | "full-redact"
  | "null-out"
  | "consistent-hash"
  | { t: "partial"; keepStart?: number; keepEnd?: number; glyph?: string }
  | { t: "generalize"; granularity: Granularity };

/** The closed set of transform KINDS — the param-free preset names plus the
 *  parametric `t` discriminants. This is the unit the drift check compares
 *  against the cloud's catalog (a rule's params don't affect skew safety; the
 *  KIND is what an engine must recognize to apply it). */
export const TRANSFORM_KINDS = [
  "full-redact",
  "null-out",
  "consistent-hash",
  "partial",
  "generalize",
] as const;

export type TransformKind = (typeof TRANSFORM_KINDS)[number];

/** Back-compat aliases. `TRANSFORM_NAMES` historically listed the bare-string
 *  catalog; it now enumerates transform KINDS (the drift check imports it under
 *  this name). `TransformName` aliases `TransformKind`. */
export const TRANSFORM_NAMES = TRANSFORM_KINDS;
export type TransformName = TransformKind;

/** The discriminant of a rule: the preset string itself, or the object's `t`. */
export function ruleKind(rule: MaskRule): TransformKind {
  return typeof rule === "string" ? rule : rule.t;
}

/** True iff `value` is one of the param-free preset names. */
export function isPresetName(value: unknown): value is "full-redact" | "null-out" | "consistent-hash" {
  return value === "full-redact" || value === "null-out" || value === "consistent-hash";
}

/** True iff `value` names a known transform KIND (preset or discriminant). */
export function isTransformKind(value: unknown): value is TransformKind {
  return (
    typeof value === "string" &&
    (TRANSFORM_KINDS as readonly string[]).includes(value)
  );
}
/** @deprecated use {@link isTransformKind} — kept for the public barrel. */
export const isTransformName = isTransformKind;

/** Thrown when a rule's kind is not in the catalog. The masker maps this to a
 *  fail-closed reject — never a passthrough. */
export class UnknownTransformError extends Error {
  constructor(public readonly name: string) {
    super(`unknown masking transform: ${name}`);
    this.name = "UnknownTransformError";
  }
}

export interface TransformContext {
  /** Per-(project|database) secret keying the deterministic transforms. Same
   *  salt + same value => same masked output, so masked join keys stay stable.
   *  Two different salts MUST yield different outputs. */
  salt: string;
}

// The constant token a fully-redacted value collapses to. Not value-derived,
// so it carries zero information about the original.
const FULL_REDACT_TOKEN = "***";

// Default mask glyph for `partial`. A masked value, not real data, so the exact
// glyph is cosmetic; "•" matches the exposure-scan wireframe.
const DEFAULT_GLYPH = "•";

/** full-redact: collapse any value to a constant token. Type-agnostic; the
 *  masker only routes scalar columns here (jsonb/array are rejected upstream). */
function fullRedact(): string {
  return FULL_REDACT_TOKEN;
}

/** null-out: replace any value with SQL NULL. The only TYPE-PRESERVING
 *  transform — a masked column keeps its declared Postgres type (an int column
 *  stays an int-typed NULL) instead of collapsing to the text token full-redact
 *  emits. Carries zero information about the original. */
function nullOut(): null {
  return null;
}

/** consistent-hash: deterministic pseudonym. HMAC-SHA256(salt, text(value))
 *  truncated to a stable hex token. Same (salt, value) => same token, so the
 *  agent can still join/group on the masked column; different salt => different
 *  token. Collision-resistant for join semantics. */
function consistentHash(value: unknown, ctx: TransformContext): string {
  const text = stringify(value);
  return createHmac("sha256", ctx.salt).update(text).digest("hex").slice(0, 16);
}

/** partial: reveal `keepStart` leading + `keepEnd` trailing characters, mask the
 *  rest with `glyph` (default •). Text-only (the masker fail-closes on non-text).
 *  Deterministic. Generalizes the v1 `keep-last-4` (= keepEnd:4).
 *
 *  CRITICAL short-value guard (inherited from keep-last-4): if keepStart+keepEnd
 *  would reveal the whole value (>= its length), FULLY mask — never leak a short
 *  value by revealing all of it. */
function partial(
  rule: { keepStart?: number; keepEnd?: number; glyph?: string },
  value: unknown,
): string {
  const text = stringify(value);
  const chars = [...text]; // code-point length (emoji-safe)
  const keepStart = rule.keepStart ?? 0;
  const keepEnd = rule.keepEnd ?? 0;
  const glyph = rule.glyph ?? DEFAULT_GLYPH;
  const len = chars.length;
  // Reveal nothing when the kept window covers (or exceeds) the whole value;
  // an empty value still emits one glyph so the cell never reads as blank.
  if (keepStart + keepEnd >= len) {
    return glyph.repeat(Math.max(len, 1));
  }
  const start = chars.slice(0, keepStart).join("");
  const end = keepEnd > 0 ? chars.slice(len - keepEnd).join("") : "";
  return start + glyph.repeat(len - keepStart - keepEnd) + end;
}

/** generalize: reduce precision while keeping statistical utility (the anon
 *  generalization / date_trunc idea). Deterministic.
 *
 *  - `year`/`month`/`day` truncate a date/timestamp (in UTC — the engine runs
 *    UTC) to the start of that unit. Output stays a Date (date family).
 *  - a positive number rounds a numeric DOWN to a multiple of that width
 *    (e.g. 73_500 with width 1000 → 73_000 — a salary band). Output stays
 *    numeric.
 *
 *  The masker proves the column's type matches the granularity before calling
 *  this (date granularity ⇒ date column, numeric width ⇒ numeric column), so a
 *  bad pairing rejects the result set rather than reaching here. */
function generalize(rule: { granularity: Granularity }, value: unknown): unknown {
  const g = rule.granularity;
  if (g === "year" || g === "month" || g === "day") {
    return truncateDate(value, g);
  }
  return bucketNumber(value, g);
}

function truncateDate(value: unknown, unit: "year" | "month" | "day"): Date | null {
  const d = value instanceof Date ? value : new Date(String(value));
  const ms = d.getTime();
  if (Number.isNaN(ms)) return null; // unparseable → drop, never leak
  const y = d.getUTCFullYear();
  const mo = unit === "year" ? 0 : d.getUTCMonth();
  const day = unit === "day" ? d.getUTCDate() : 1;
  return new Date(Date.UTC(y, mo, day));
}

function bucketNumber(value: unknown, width: number): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !(width > 0)) return null; // never leak on bad input
  return Math.floor(n / width) * width;
}

// Stable text form of a scalar cell for the value-dependent transforms. The
// masker guarantees we never see jsonb/array here (those columns are rejected),
// so this only handles scalar types pg hands back: string | number | bigint |
// boolean | Date. Deterministic across calls.
function stringify(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Apply a declared mask rule to one result-set cell.
 *
 * NULL passes through as NULL (documented limitation). Any unrecognized rule
 * kind throws UnknownTransformError — the masker turns that into a fail-closed
 * reject, never a passthrough of the real value. The caller (mask-result-set)
 * has already enforced each parametric rule's input-type domain.
 */
export function applyTransform(
  rule: MaskRule,
  value: unknown,
  ctx: TransformContext,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof rule === "string") {
    switch (rule) {
      case "full-redact":
        return fullRedact();
      case "null-out":
        return nullOut();
      case "consistent-hash":
        return consistentHash(value, ctx);
      default: {
        // Exhaustiveness guard: a new preset without a case is a compile error.
        // At runtime an out-of-catalog string lands here and fails closed.
        const _exhaustive: never = rule;
        throw new UnknownTransformError(String(_exhaustive));
      }
    }
  }
  switch (rule.t) {
    case "partial":
      return partial(rule, value);
    case "generalize":
      return generalize(rule, value);
    default: {
      const _exhaustive: never = rule;
      throw new UnknownTransformError(JSON.stringify(_exhaustive));
    }
  }
}
