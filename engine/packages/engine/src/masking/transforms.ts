// Masking transforms — the catalog of value transforms applied to a result-set
// cell when its source column is declared masked.
//
// Design (see masking-transform-catalog design doc; decisions E2 + CQ4):
//   - DETERMINISTIC (the floor): a value-dependent transform maps the same input
//     to the same output every time (a join over a consistent-hashed / generalized
//     / pseudonymized key still groups). Determinism is the requirement for every
//     transform EXCEPT `noise`, which is the one explicitly non-deterministic rung
//     (it breaks joins by design; the cloud picker flags it and never defaults to
//     it). Everything else here is a pure function of (rule, value, salt).
//   - SALT-INJECTED: the salt is passed in, never read from global state, so
//     determinism is unit-testable and the salt-scope decision is a wiring change.
//   - NO RUNTIME FILE READS: everything here is pure code + node:crypto (a static
//     import) + the TS-literal dictionaries in ./dictionaries.ts. A
//     `bun build --compile` binary does NOT embed assets read at runtime via
//     readFileSync (see learning bun-compile-readfilesync-not-embedded), so a
//     wordlist on disk would ENOENT — the dictionaries ship as module constants.
//   - FAIL-CLOSED: `applyTransform` is exhaustive over MaskRule; an unrecognized
//     preset string or parametric `t` throws (UnknownTransformError) so the masker
//     rejects the column rather than passing the real value through. This is the
//     defense against cloud↔engine version skew (decision A3): a stale engine that
//     does not know a transform MUST deny, never leak. A type-changing transform
//     applied to an out-of-domain value (e.g. `noise` on text, date `generalize`
//     on a non-date) redacts to NULL rather than leaking — fail-SAFE, never the
//     original value.
//
// The value shape is a discriminated union: param-free presets stay bare strings
// (`full-redact`, `null-out`, `consistent-hash`); parametric transforms are
// objects tagged by `t` (`partial`, `generalize`, `pseudonymize`, `noise`). The
// old fixed `keep-last-4` preset is retired — `{ t: "partial", keepEnd: 4 }`
// expresses it and more.
//
// NULL handling (design "v1 masking semantics"): a NULL cell stays NULL. This
// leaks "this row has no value" and is an accepted, documented v1 limitation.
// (`null-out` makes NULL a transform TARGET — every value becomes NULL — which is
// distinct from this passthrough of an already-NULL input.)

import { createHmac } from "node:crypto";
import { FIRST_NAMES, LAST_NAMES, EMAIL_DOMAINS } from "./dictionaries.ts";

// ── Catalog identifiers ─────────────────────────────────────────────────────
// Param-free presets — the value is the bare string. Order is significant
// (stable serialization + the cloud↔engine drift check).
export const MASK_PRESETS = [
  "full-redact",
  "null-out",
  "consistent-hash",
] as const;
export type MaskPreset = (typeof MASK_PRESETS)[number];

// Parametric transforms — the value is an object tagged by `t`.
export const MASK_PARAMETRIC_KINDS = [
  "partial",
  "generalize",
  "pseudonymize",
  "noise",
] as const;
export type MaskParametricKind = (typeof MASK_PARAMETRIC_KINDS)[number];

// The full catalog of transform identifiers, presets then parametric kinds, in a
// fixed order. The cloud's MASK_TRANSFORM_KINDS mirrors this EXACTLY — the
// `check:transforms` drift guard fails CI if they diverge.
export const TRANSFORM_KINDS = [
  ...MASK_PRESETS,
  ...MASK_PARAMETRIC_KINDS,
] as const;

// `generalize` date buckets. A `granularity` that is one of these truncates a
// date/timestamp; a positive number instead buckets a numeric value.
export const GENERALIZE_DATE_GRANULARITIES = ["year", "month", "day"] as const;
export type GeneralizeDateGranularity =
  (typeof GENERALIZE_DATE_GRANULARITIES)[number];
export type GeneralizeGranularity = GeneralizeDateGranularity | number;

// `pseudonymize` kinds — the realistic-fake shapes, drawn from the PII categories
// the scanner already recognizes so scan → suggest → pseudonymize is one path.
export const PSEUDONYMIZE_KINDS = [
  "email",
  "name",
  "first_name",
  "last_name",
  "phone",
] as const;
export type PseudonymizeKind = (typeof PSEUDONYMIZE_KINDS)[number];

// ── Parameter bounds (shared by applyTransform and the config zod schema) ────
/** Cap on `keepStart + keepEnd` for `partial` — a sanity bound so a policy can't
 *  request revealing an absurd number of characters (the short-value guard still
 *  fully masks anything where the kept span would cover the whole value). */
export const PARTIAL_MAX_KEEP = 64;
/** Default mask glyph for `partial` (matches the exposure-scan wireframe). */
export const DEFAULT_PARTIAL_GLYPH = "•";
/** Upper bound on `noise` ratio — a sanity cap (1.0 = ±100%). */
export const NOISE_MAX_RATIO = 10;

// ── The rule union ───────────────────────────────────────────────────────────
export type MaskRule =
  | MaskPreset
  | { t: "partial"; keepStart?: number; keepEnd?: number; glyph?: string }
  | { t: "generalize"; granularity: GeneralizeGranularity }
  | { t: "pseudonymize"; kind: PseudonymizeKind }
  | { t: "noise"; ratio: number };

/** A param-free preset string (legacy callers may type a cell as just this). */
export type TransformName = MaskPreset;

/** Structural check that an unknown value is a well-formed MaskRule. Defense in
 *  depth — the engine's zod schema is the real parse-time gate; this is for tests
 *  and any non-zod caller. Bound enforcement matches the zod schema. */
export function isMaskRule(value: unknown): value is MaskRule {
  if (typeof value === "string") {
    return (MASK_PRESETS as readonly string[]).includes(value);
  }
  if (value === null || typeof value !== "object") return false;
  const r = value as { t?: unknown };
  switch (r.t) {
    case "partial": {
      const p = value as { keepStart?: unknown; keepEnd?: unknown; glyph?: unknown };
      const okNum = (n: unknown) =>
        n === undefined || (typeof n === "number" && Number.isInteger(n) && n >= 0);
      const start = typeof p.keepStart === "number" ? p.keepStart : 0;
      const end = typeof p.keepEnd === "number" ? p.keepEnd : 0;
      return (
        okNum(p.keepStart) &&
        okNum(p.keepEnd) &&
        start + end <= PARTIAL_MAX_KEEP &&
        (p.glyph === undefined ||
          (typeof p.glyph === "string" && [...p.glyph].length === 1))
      );
    }
    case "generalize": {
      const g = (value as { granularity?: unknown }).granularity;
      return (
        (typeof g === "string" &&
          (GENERALIZE_DATE_GRANULARITIES as readonly string[]).includes(g)) ||
        (typeof g === "number" && Number.isFinite(g) && g > 0)
      );
    }
    case "pseudonymize":
      return (PSEUDONYMIZE_KINDS as readonly string[]).includes(
        (value as { kind?: unknown }).kind as string,
      );
    case "noise": {
      const ratio = (value as { ratio?: unknown }).ratio;
      return typeof ratio === "number" && ratio > 0 && ratio <= NOISE_MAX_RATIO;
    }
    default:
      return false;
  }
}

/** Thrown when a transform is not in the catalog (unknown preset string or
 *  unknown parametric `t`). The masker maps this to a fail-closed reject — never
 *  a passthrough. */
export class UnknownTransformError extends Error {
  /** The offending transform identifier (a preset string or `t=…`). */
  readonly transform: string;
  constructor(transform: string) {
    super(`unknown masking transform: ${transform}`);
    this.name = "UnknownTransformError";
    this.transform = transform;
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

/** full-redact: collapse any value to a constant token. */
function fullRedact(): string {
  return FULL_REDACT_TOKEN;
}

/** consistent-hash: deterministic pseudonym. HMAC-SHA256(salt, text(value))
 *  truncated to a stable hex token. */
function consistentHash(value: unknown, ctx: TransformContext): string {
  return createHmac("sha256", ctx.salt)
    .update(stringify(value))
    .digest("hex")
    .slice(0, 16);
}

/** partial: reveal `keepStart` leading + `keepEnd` trailing characters, mask the
 *  rest with `glyph`. Text-shaped (type-gated to text columns in the cloud UI).
 *  CRITICAL edge (inherited from keep-last-4): if the kept span would cover the
 *  whole value (`keepStart + keepEnd >= len`), FULLY mask — revealing a short
 *  value would leak 100% of it. `keep-last-4` is exactly `partial{keepEnd:4}`. */
function partial(
  value: unknown,
  opts: { keepStart?: number; keepEnd?: number; glyph?: string },
): string {
  const glyph = opts.glyph ?? DEFAULT_PARTIAL_GLYPH;
  const keepStart = Math.max(0, Math.trunc(opts.keepStart ?? 0));
  const keepEnd = Math.max(0, Math.trunc(opts.keepEnd ?? 0));
  const chars = [...stringify(value)];
  const n = chars.length;
  // Short-value guard: never reveal the whole (or more than the whole) value.
  if (keepStart + keepEnd >= n) {
    return glyph.repeat(Math.max(n, 1));
  }
  const head = chars.slice(0, keepStart).join("");
  const tail = keepEnd > 0 ? chars.slice(n - keepEnd).join("") : "";
  return head + glyph.repeat(n - keepStart - keepEnd) + tail;
}

/** generalize: bucket a value to reduce precision while keeping statistical
 *  utility. Date/timestamp → truncate to year/month/day (output is a canonical
 *  date string, type-changing within the date family). Numeric → round down to a
 *  bucket of `granularity` width (output stays numeric). Deterministic. An
 *  out-of-domain value (e.g. a date granularity on a non-date) redacts to NULL —
 *  fail-SAFE, never leaks the original. */
function generalize(value: unknown, granularity: GeneralizeGranularity): unknown {
  if (typeof granularity === "string") {
    const d = toDate(value);
    if (!d) return null; // not a date — redact rather than leak
    const y = d.getUTCFullYear();
    const pad = (x: number) => String(x).padStart(2, "0");
    if (granularity === "year") return `${y}-01-01`;
    if (granularity === "month") return `${y}-${pad(d.getUTCMonth() + 1)}-01`;
    return `${y}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; // "day"
  }
  // Numeric bucket. Guard the width even though zod already bounds it.
  if (!Number.isFinite(granularity) || granularity <= 0) return null;
  const n = toNumber(value);
  if (n === null) return null; // not numeric — redact
  return Math.floor(n / granularity) * granularity;
}

/** pseudonymize: a realistic, deterministic fake of the same SHAPE as the input.
 *  Same (salt, value, kind) → same fake (join-safe); a different project salt →
 *  uncorrelated, same guarantee as consistent-hash. Picks from the embedded
 *  dictionaries by HMAC index. Output is always text (a fake name/email/phone).
 *
 *  A masking transform must NEVER emit the original value. Because the index is
 *  HMAC-derived, an input already shaped like the embedded dictionary data can
 *  hash back to itself for some salts (e.g. "Frankie" → "Frankie"). When the
 *  generated fake equals the (normalized) input we advance every index by one and
 *  recompose — dictionary entries are distinct and each synthetic component
 *  changes, so the bumped fake can never equal the input — keeping the result
 *  deterministic. */
function pseudonymize(
  value: unknown,
  kind: PseudonymizeKind,
  ctx: TransformContext,
): string {
  const text = stringify(value);
  // Two independent indices from one digest so name/email don't lock first and
  // last together (every "Avery" would otherwise always be "Avery Adler").
  const digest = createHmac("sha256", ctx.salt).update(`${kind}:${text}`).digest();

  // Compose the fake from the digest with `bump` added to every index. bump=0 is
  // the normal draw (identical to the un-bumped output); bump=1 is the collision
  // fallback — a distinct draw, used only when bump=0 would echo the input.
  const compose = (bump: number): string => {
    const first = FIRST_NAMES[(digest.readUInt32BE(0) + bump) % FIRST_NAMES.length]!;
    const last = LAST_NAMES[(digest.readUInt32BE(4) + bump) % LAST_NAMES.length]!;
    switch (kind) {
      case "first_name":
        return first;
      case "last_name":
        return last;
      case "name":
        return `${first} ${last}`;
      case "email": {
        const domain = EMAIL_DOMAINS[(digest.readUInt32BE(8) + bump) % EMAIL_DOMAINS.length]!;
        return `${first}.${last}@${domain}`.toLowerCase();
      }
      case "phone": {
        // North-American fictional range: area + 555-01xx (555-01NN reserved for
        // fiction). Deterministic digits from the digest.
        const area = 200 + ((digest.readUInt32BE(12) + bump) % 800); // 200–999
        const line = (digest.readUInt32BE(16) + bump) % 100; // 00–99
        return `+1-${area}-555-01${String(line).padStart(2, "0")}`;
      }
      default: {
        const _exhaustive: never = kind;
        throw new UnknownTransformError(`pseudonymize:${String(_exhaustive)}`);
      }
    }
  };

  const candidate = compose(0);
  // Compare case-insensitively (email is emitted lowercased) so a same-value /
  // different-case fake is also treated as a leak. On collision, the +1 draw is
  // guaranteed distinct from the input.
  return candidate.toLowerCase() === text.trim().toLowerCase() ? compose(1) : candidate;
}

/** noise: the one NON-deterministic transform. Adds proportional jitter of up to
 *  ±`ratio` to a numeric value (anon.noise), so aggregate distribution survives
 *  but exact values — and joins/grouping on this column — do NOT. Integer inputs
 *  stay integers. A non-numeric value redacts to NULL (fail-SAFE). */
function noise(value: unknown, ratio: number): unknown {
  const n = toNumber(value);
  if (n === null) return null; // not numeric — redact rather than leak
  const noised = n * (1 + ratio * (2 * Math.random() - 1));
  return Number.isInteger(n) ? Math.round(noised) : noised;
}

// Stable text form of a scalar cell for the value-dependent transforms. The
// masker guarantees we never see jsonb/array here (those columns are rejected),
// so this only handles scalar types pg hands back: string | number | bigint |
// boolean | Date. Deterministic across calls.
function stringify(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// Best-effort coercion of a cell to a Date (for date `generalize`). pg hands a
// `date` column back as a "YYYY-MM-DD" string and a timestamp as a Date; both
// resolve here. Returns null for anything not date-like — the caller redacts.
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Best-effort coercion of a cell to a finite number (for numeric `generalize`
// and `noise`). Handles number, bigint, and numeric strings pg returns for
// int8/numeric. Returns null for anything not numeric — the caller redacts.
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Apply a declared transform to one result-set cell.
 *
 * NULL passes through as NULL (documented v1 limitation). Any unrecognized
 * preset or parametric `t` throws UnknownTransformError — the masker turns that
 * into a fail-closed reject, never a passthrough of the real value.
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
        return null;
      case "consistent-hash":
        return consistentHash(value, ctx);
      default: {
        // Exhaustiveness guard over MaskPreset. At runtime an out-of-catalog
        // string lands here and fails closed.
        const _exhaustive: never = rule;
        throw new UnknownTransformError(String(_exhaustive));
      }
    }
  }

  switch (rule.t) {
    case "partial":
      return partial(value, rule);
    case "generalize":
      return generalize(value, rule.granularity);
    case "pseudonymize":
      return pseudonymize(value, rule.kind, ctx);
    case "noise":
      return noise(value, rule.ratio);
    default: {
      // Exhaustiveness guard over the parametric arm. A newer cloud's unknown
      // `t` lands here and fails closed.
      const _exhaustive: never = rule;
      throw new UnknownTransformError(
        `t=${String((_exhaustive as { t?: unknown }).t)}`,
      );
    }
  }
}
