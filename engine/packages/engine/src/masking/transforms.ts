// Masking transforms — the v1 catalog of value transforms applied to a
// result-set cell when its source column is declared masked.
//
// Design (see column-policies-masking design doc, decisions E2 + CQ4):
//   - DETERMINISTIC: a value-dependent transform MUST map the same input to
//     the same output every time (a join over a consistent-hashed key has to
//     still group). Determinism is a requirement, not a nicety.
//   - SALT-INJECTED: the salt is passed in, never read from global state, so
//     determinism is unit-testable and the salt-scope decision is a wiring
//     change, not a code change.
//   - NO RUNTIME FILE READS: everything here is pure code + node:crypto (a
//     static import). A `bun build --compile` binary does NOT embed assets read
//     at runtime via readFileSync (see learning bun-compile-readfilesync-not-
//     embedded), so a wordlist on disk would ENOENT in the shipped engine.
//   - FAIL-CLOSED: `applyTransform` is exhaustive over TransformName; an
//     unrecognized transform throws (UnknownTransformError) so the masker
//     rejects the column rather than passing the real value through. This is
//     the defense against cloud↔engine version skew (decision A3): a stale
//     engine that does not know a transform name MUST deny, never leak.
//
// Catalog (decision E2): full-redact, null-out, consistent-hash, keep-last-4
// (the last is text-only and type-gated in the cloud UI). null-out is the only
// TYPE-PRESERVING transform — it masks to SQL NULL, so a masked column keeps its
// declared Postgres type; the others collapse to a text token.
// format-preserving-fake is deferred (a per-type family of generators).
//
// NULL handling (design "v1 masking semantics"): a NULL cell stays NULL. This
// leaks "this row has no value" and is an accepted, documented v1 limitation.
// (null-out makes NULL a transform TARGET — every value becomes NULL — which is
// distinct from this passthrough of an already-NULL input.)

import { createHmac } from "node:crypto";

export const TRANSFORM_NAMES = [
  "full-redact",
  "null-out",
  "consistent-hash",
  "keep-last-4",
] as const;

export type TransformName = (typeof TRANSFORM_NAMES)[number];

export function isTransformName(value: unknown): value is TransformName {
  return (
    typeof value === "string" &&
    (TRANSFORM_NAMES as readonly string[]).includes(value)
  );
}

/** Thrown when a transform name is not in the v1 catalog. The masker maps this
 *  to a fail-closed reject — never a passthrough. */
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

// Mask glyph for keep-last-4. A masked value, not real data, so the exact
// glyph is cosmetic; "•" matches the exposure-scan wireframe.
const KEEP_LAST_4_MASK = "•"; // •
const KEEP = 4;

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

/** keep-last-4: reveal only the final 4 characters, mask the rest. Text-only
 *  (type-gated in the UI). CRITICAL edge: a value of length <= 4 is FULLY
 *  masked — returning the whole short value would leak 100% of it. */
function keepLast4(value: unknown): string {
  const text = stringify(value);
  // Use the string's character length. For <=4 chars, reveal nothing.
  const chars = [...text];
  if (chars.length <= KEEP) {
    return KEEP_LAST_4_MASK.repeat(Math.max(chars.length, 1));
  }
  const last = chars.slice(chars.length - KEEP).join("");
  return KEEP_LAST_4_MASK.repeat(chars.length - KEEP) + last;
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
 * Apply a declared transform to one result-set cell.
 *
 * NULL passes through as NULL (documented v1 limitation). Any unrecognized
 * transform throws UnknownTransformError — the masker turns that into a
 * fail-closed reject, never a passthrough of the real value.
 */
export function applyTransform(
  name: TransformName,
  value: unknown,
  ctx: TransformContext,
): unknown {
  if (value === null || value === undefined) return value;
  switch (name) {
    case "full-redact":
      return fullRedact();
    case "null-out":
      return nullOut();
    case "consistent-hash":
      return consistentHash(value, ctx);
    case "keep-last-4":
      return keepLast4(value);
    default: {
      // Exhaustiveness guard: if a new TransformName is added without a case,
      // this is a compile error. At runtime an out-of-catalog string lands
      // here and fails closed.
      const _exhaustive: never = name;
      throw new UnknownTransformError(String(_exhaustive));
    }
  }
}
