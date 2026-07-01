// Postgres SQL emission for mask rules — the source-rewrite counterpart of
// transforms.ts `applyTransform` (which runs the same transforms in JS for the
// retained post-exec masker). Dialect-specific by nature (md5 / date_trunc / …),
// so it lives under dialects/postgres (eng-review A1). A value-corpus parity test
// (ET, Phase 1) pins these two implementations to the same outputs.
//
// Fail-closed: an out-of-domain pairing (e.g. `partial` on a numeric column) or a
// transform that isn't source-rewritable (`pseudonymize` — dictionary, projection-
// only v1) returns { ok:false } so the rewriter rejects the whole statement rather
// than emit wrong SQL. Mirrors the post-exec masker's checkInputDomain, plus the
// Codex #7 tightening (full-redact / consistent-hash collapse to text → text-only
// under rewrite, where post-exec treated them as domain-free).

import { ruleKind, type Granularity, type MaskRule } from "../../masking/transforms.ts";
import { MASK_SALT_GUC } from "../../masking/source-rewrite.ts";

export type SqlEmit = { ok: true; sql: string } | { ok: false; reason: string };

// pg_type.typcategory letters the input domains key on (same as the post-exec masker).
const STRING = "S";
const DATETIME = "D";
const NUMERIC = "N";

/** Double-quote a Postgres identifier (internal `"` doubled) — defends against
 *  exotic catalog names like `"; --"` (eng-review §3, identifier injection). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quote a Postgres string literal (internal `'` doubled) — defends against
 *  string-valued mask params like `partial`'s glyph (eng-review §2 C2). */
export function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Emit the masking expression for `rule` over `col` (an already-quoted column
 *  reference valid inside the wrap subquery). `category` is the column's
 *  pg_type.typcategory; an absent/mismatched category fails closed. */
export function transformToSql(
  rule: MaskRule,
  col: string,
  category: string | undefined,
): SqlEmit {
  const kind = ruleKind(rule);
  const reject = (reason: string): SqlEmit => ({ ok: false, reason });
  switch (kind) {
    case "null-out":
      // Untyped NULL is type-safe in both projection and predicate position, so it
      // preserves the column's downstream usability (NULL > 5 is NULL, not a type
      // error). The one type-preserving transform.
      return { ok: true, sql: "NULL" };
    case "full-redact":
      return category === STRING
        ? { ok: true, sql: "'***'::text" }
        : reject("full-redact collapses to text — valid only on a text column under rewrite");
    case "consistent-hash":
      return category === STRING
        ? {
            ok: true,
            // Salt via the transaction-local GUC (set + verified by the coordinator).
            // ::text matches the JS path's md5(salt || stringify(value)) for text
            // columns (D2 token alignment) so the rollback flag is token-stable.
            sql: `md5(current_setting(${quoteLiteral(MASK_SALT_GUC)}) || ${col}::text)`,
          }
        : reject("consistent-hash emits text — valid only on a text column under rewrite");
    case "partial": {
      if (category !== STRING) return reject("partial is text-only");
      const r = rule as { keepStart?: number; keepEnd?: number; glyph?: string };
      return { ok: true, sql: partialSql(col, r.keepStart ?? 0, r.keepEnd ?? 0, r.glyph ?? "•") };
    }
    case "generalize": {
      const g = (rule as { granularity: Granularity }).granularity;
      if (g === "year" || g === "month" || g === "day") {
        return category === DATETIME
          ? { ok: true, sql: `date_trunc(${quoteLiteral(g)}, ${col})` }
          : reject(`generalize:${g} needs a date/timestamp column`);
      }
      if (category !== NUMERIC) return reject("a numeric generalize bucket needs a numeric column");
      if (typeof g !== "number" || !(g > 0)) return reject("generalize bucket width must be a positive number");
      return { ok: true, sql: `(floor(${col} / ${g}) * ${g})` };
    }
    case "noise": {
      if (category !== NUMERIC) return reject("noise needs a numeric column");
      const ratio = (rule as { ratio: number }).ratio;
      if (typeof ratio !== "number" || !(ratio > 0)) return reject("noise ratio must be a positive number");
      // Non-deterministic by design (breaks joins/grouping on the column).
      return { ok: true, sql: `(${col} * (1 + (random() * 2 - 1) * ${ratio}))` };
    }
    case "pseudonymize":
      // Dictionary transform — projection-only in v1, handled by the retained
      // post-exec masker; the mask-safety gate rejects a computed position over a
      // pseudonymized column. The source-rewriter never emits it.
      return reject("pseudonymize is projection-only in v1 (not source-rewritten)");
    default:
      return reject(`unknown transform: ${String(kind)}`);
  }
}

// Mirror transforms.ts partial(): fully mask when the kept window covers the whole
// value (never leak a short value by revealing all of it); else reveal first
// `keepStart` + last `keepEnd` chars and glyph the middle. NOTE: SQL length()/left()/
// right() are character-based; transforms.ts uses code-point slicing — the parity
// test pins the (rare) multibyte divergence.
function partialSql(col: string, keepStart: number, keepEnd: number, glyph: string): string {
  const g = quoteLiteral(glyph);
  const len = `length(${col})`;
  const keep = keepStart + keepEnd;
  const full = `repeat(${g}, GREATEST(${len}, 1))`;
  const masked = `left(${col}, ${keepStart}) || repeat(${g}, ${len} - ${keep}) || right(${col}, ${keepEnd})`;
  return `CASE WHEN ${len} <= ${keep} THEN ${full} ELSE ${masked} END`;
}
