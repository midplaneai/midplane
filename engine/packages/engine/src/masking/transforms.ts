// Masking transforms — the catalog of value transforms applied to a result-set
// cell when its source column is declared masked.
//
// Design (see column-policies-masking design doc + masking-transform-catalog):
//   - DETERMINISTIC (with ONE opt-in exception): a value-dependent transform
//     maps the same input to the same output every time, so a join over a
//     masked key still groups. `partial`/`generalize` are pure functions of the
//     value; `consistent-hash`/`pseudonymize` are pure functions of (salt,
//     value). The SOLE exception is `noise`, which is explicitly
//     NON-DETERMINISTIC by design — it randomizes a numeric so exact values
//     can't survive, breaking joins/grouping on that column. `noise` is never a
//     default, the UI flags it ("breaks joins"), and the scanner never suggests
//     it; every other transform here is deterministic, which is the masking
//     floor, not a nicety.
//   - SALT-INJECTED: the salt is passed in, never read from global state, so
//     determinism is unit-testable and the salt-scope decision is a wiring
//     change, not a code change.
//   - NO RUNTIME FILE READS: everything here is pure code + node:crypto (a
//     static import) + the `pseudonymize` dictionaries, which ship as STATIC TS
//     modules (./dictionaries/*.ts) imported at the top — so they're embedded in
//     the compiled binary. A `bun build --compile` binary does NOT embed assets
//     read at runtime via readFileSync (see learning bun-compile-readfilesync-
//     not-embedded), so a wordlist on disk would ENOENT in the shipped engine.
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
//   - `partial`       text → text       (reveal a few chars, mask the rest)
//   - `generalize`    date|num → date|num (truncate a date / bucket a number)
//   - `pseudonymize`  text → text       (a realistic, deterministic fake from a
//                                         compiled-in dictionary keyed by `kind`)
//   - `noise`         num → num         (randomized within ±ratio — the lone
//                                         non-deterministic transform)
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
import { PSEUDONYM_EMAILS } from "./dictionaries/emails.ts";
import { PSEUDONYM_NAMES } from "./dictionaries/names.ts";
import { PSEUDONYM_PHONES } from "./dictionaries/phones.ts";

/** Date-truncation unit, or a positive numeric bucket width. `year`/`month`/
 *  `day` truncate a date/timestamp; a number rounds a numeric down to a multiple
 *  of that width (e.g. 1000 → salary band). */
export type Granularity = "year" | "month" | "day" | number;

/** The `pseudonymize` kinds — a CLOSED subset of the scanner's PII categories
 *  that the engine actually ships a dictionary for. The cloud's accepted kinds
 *  MUST equal this set (a second lockstep beyond the transform-KIND drift check;
 *  scripts/check-mask-transforms.ts compares both). An unknown kind fails CLOSED
 *  at runtime (pseudonymize throws → reject) and at boot (config zod rejects it).
 *  Order is significant for the drift comparison. */
export const PSEUDONYMIZE_KINDS = ["email", "name", "phone"] as const;
export type PseudonymizeKind = (typeof PSEUDONYMIZE_KINDS)[number];

/** A declared mask rule: a param-free preset name, or a parametric transform
 *  tagged by its `t` discriminant. The cloud authors these; the engine applies
 *  them. Mirrored by the cloud's `MaskRule` (packages/db/src/policy.ts), kept in
 *  lockstep by scripts/check-mask-transforms.ts. */
export type MaskRule =
  | "full-redact"
  | "null-out"
  | "consistent-hash"
  | { t: "partial"; keepStart?: number; keepEnd?: number; glyph?: string }
  | { t: "generalize"; granularity: Granularity }
  | { t: "pseudonymize"; kind: PseudonymizeKind }
  | { t: "noise"; ratio: number };

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
  "pseudonymize",
  "noise",
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

// Compiled-in pseudonym dictionaries, one per kind. Static imports (above) so a
// `bun build --compile` binary embeds them. The set of keys here IS the engine's
// PSEUDONYMIZE_KINDS — a `kind` with no dictionary fails closed (pseudonymize
// throws). The cloud is drift-checked to never offer a kind missing here.
const PSEUDONYM_DICTS: Record<PseudonymizeKind, readonly string[]> = {
  email: PSEUDONYM_EMAILS,
  name: PSEUDONYM_NAMES,
  phone: PSEUDONYM_PHONES,
};

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

/** pseudonymize: a realistic, DETERMINISTIC fake drawn from a compiled-in
 *  dictionary keyed by `kind` (email / name / phone). Index =
 *  HMAC-SHA256(salt, text(value)) reduced mod the dictionary length — so the
 *  same (salt, value) always maps to the same fake (the agent can still
 *  join/group on the masked column), and a different project salt yields an
 *  uncorrelated mapping (identical guarantee to consistent-hash, but the output
 *  keeps the real value's SHAPE instead of emitting hex). Output type: text.
 *  Text-only (the masker fail-closes on non-text).
 *
 *  FAIL-CLOSED on an unknown kind: a `kind` with no dictionary (e.g. a newer
 *  cloud naming a dictionary this engine version doesn't ship) throws
 *  UnknownTransformError → the masker rejects, never passing the real value
 *  through. In production the config zod also rejects an unknown kind at boot;
 *  this is the runtime backstop. */
function pseudonymize(
  rule: { kind: PseudonymizeKind },
  value: unknown,
  ctx: TransformContext,
): string {
  const dict = PSEUDONYM_DICTS[rule.kind];
  if (!dict || dict.length === 0) {
    throw new UnknownTransformError(`pseudonymize:${String(rule.kind)}`);
  }
  const hex = createHmac("sha256", ctx.salt).update(stringify(value)).digest("hex");
  // Full-width reduction (BigInt over the whole 256-bit digest) for an even
  // spread across the dictionary regardless of its length.
  const idx = Number(BigInt(`0x${hex}`) % BigInt(dict.length));
  return dict[idx]!;
}

/** noise: additive proportional noise on a numeric value — multiply by a random
 *  factor in [1 - ratio, 1 + ratio]. The ONLY non-deterministic transform: it
 *  uses Math.random(), so repeated reads of the same row return different values
 *  and joins/grouping on the column break BY DESIGN (the UI flags this; the
 *  scanner never suggests it). Useful where only the aggregate distribution
 *  matters and exact values must not survive. Output stays numeric; a non-finite
 *  input or result drops to null (never leak), mirroring bucketNumber. Numeric-
 *  only (the masker fail-closes on non-numeric). */
function noise(rule: { ratio: number }, value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  const ratio = rule.ratio;
  if (!Number.isFinite(n) || !(ratio > 0)) return null;
  const factor = 1 + (Math.random() * 2 - 1) * ratio;
  const out = n * factor;
  return Number.isFinite(out) ? out : null;
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
    case "pseudonymize":
      return pseudonymize(rule, value, ctx);
    case "noise":
      return noise(rule, value);
    default: {
      const _exhaustive: never = rule;
      throw new UnknownTransformError(JSON.stringify(_exhaustive));
    }
  }
}
