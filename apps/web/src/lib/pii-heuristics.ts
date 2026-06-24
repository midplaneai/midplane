// Heuristic PII classification for the column-exposure scan (design D1).
//
// Deterministic, name+type only — NO data sampling (we never read customer row
// values to find PII; the scan reads information_schema and reasons about column
// NAMES and types). This is an ASSISTIVE suggestion surface: a human confirms in
// the policy editor. False positives are acceptable (the user unchecks them);
// silent false negatives just mean the user marks the column by hand. The
// suggested transform is a sensible default the user can change.
//
// Pure module (no DB, no client-only deps) so it unit-tests trivially and can
// run either server-side (the scan API) or in a preview.

import type { MaskRule } from "@midplane-cloud/db/policy";

export type PiiCategory =
  | "email"
  | "phone"
  | "ssn"
  | "credit_card"
  | "dob"
  | "name"
  | "address"
  | "ip";

export type PiiConfidence = "high" | "medium" | "low";

export interface PiiMatch {
  category: PiiCategory;
  confidence: PiiConfidence;
  /** A sensible default transform for this category; the user can change it. */
  suggestedTransform: MaskRule;
}

// Ordered most-specific → least-specific; the first match wins so "ssn" beats a
// generic "name" substring and "email" beats nothing. Each rule carries the
// confidence and a default transform. The defaults stay on the deterministic
// floor (partial / full-redact / generalize) — the spike tier (pseudonymize,
// noise) is never a suggestion, per the masking design. A text-shaped transform
// on a NON-text column would silently change the column's type, so on such a
// column the suggestion downgrades to null-out (type-preserving — see
// classifyColumn).
interface Rule {
  category: PiiCategory;
  test: RegExp;
  confidence: PiiConfidence;
  transform: MaskRule;
}

// partial{keepEnd:4} — the offered replacement for the retired keep-last-4. Used
// for the "reveal a tail for recognizability" categories (ssn, card, phone).
const LAST_4: MaskRule = { t: "partial", keepEnd: 4 };

// Column names are normalized to lower snake/word form before matching.
const RULES: Rule[] = [
  { category: "ssn", test: /(^|_)ssn($|_)|social_secur|(^|_)tin($|_)|tax_?id/, confidence: "high", transform: LAST_4 },
  { category: "credit_card", test: /credit_?card|card_?number|(^|_)ccnum|cc_?number|card_?no(^|$|_)|(^|_)pan($|_)/, confidence: "high", transform: LAST_4 },
  { category: "email", test: /(^|_)e_?mail($|_)|email_addr|mail_address/, confidence: "high", transform: "full-redact" },
  { category: "phone", test: /(^|_)phone($|_)|phone_?number|mobile_?(no|number)?|(^|_)tel($|_)|telephone|(^|_)fax($|_)/, confidence: "high", transform: LAST_4 },
  // dob → birth YEAR: the identifier dies, age-cohort analytics survive. Falls
  // back below when the column isn't date- or text-shaped.
  { category: "dob", test: /date_?of_?birth|(^|_)dob($|_)|birth_?date|birthday/, confidence: "high", transform: { t: "generalize", granularity: "year" } },
  // Before "address" so "ip_address" classifies as ip, not a street address.
  { category: "ip", test: /ip_?address|(^|_)ip($|_)/, confidence: "low", transform: "full-redact" },
  { category: "address", test: /(^|_)address($|_)|street_?(addr|address|name)?|postal_?code|(^|_)zip(code)?($|_)/, confidence: "medium", transform: "full-redact" },
  { category: "name", test: /first_?name|last_?name|full_?name|(^|_)fname($|_)|(^|_)lname($|_)|surname|given_?name|family_?name/, confidence: "medium", transform: "full-redact" },
  // Bare "name" is a weak signal (table_name, file_name, display_name): low.
  { category: "name", test: /(^|_)name($|_)/, confidence: "low", transform: "full-redact" },
];

// Postgres data types the text-shaped transforms can operate on (text-like). On
// anything else, a text-shaped suggestion downgrades to null-out
// (type-preserving), mirroring the picker's type-gate and the engine's text-only
// partial.
const TEXT_TYPES = new Set([
  "text",
  "character varying",
  "varchar",
  "character",
  "char",
  "bpchar",
  "citext",
  "name",
]);

function isTextType(dataType: string): boolean {
  const t = dataType.toLowerCase().trim();
  return TEXT_TYPES.has(t) || t.startsWith("character") || t.startsWith("varchar");
}

// Postgres date/timestamp types `generalize{granularity: year|month|day}` can
// bucket. A pg `date` arrives as a "YYYY-MM-DD" string and a timestamp as a Date;
// the engine parses both, and a date-shaped text column works too.
const DATE_TYPES = new Set([
  "date",
  "timestamp",
  "timestamp with time zone",
  "timestamp without time zone",
  "timestamptz",
]);

function isDateType(dataType: string): boolean {
  const t = dataType.toLowerCase().trim();
  return DATE_TYPES.has(t) || t.startsWith("timestamp") || t === "date";
}

// Text-shaped transforms change a non-text column's type (they emit a text
// token / masked string), so they're only type-valid on text columns.
function isTextShaped(rule: MaskRule): boolean {
  return (
    rule === "full-redact" || (typeof rule === "object" && rule.t === "partial")
  );
}

function isDateGeneralize(rule: MaskRule): boolean {
  return (
    typeof rule === "object" &&
    rule.t === "generalize" &&
    typeof rule.granularity === "string"
  );
}

/**
 * Classify a column as likely PII from its name + Postgres data type, or null.
 * The match is the first (most-specific) rule whose pattern hits the normalized
 * column name. The suggested transform is then adjusted to stay type-valid: a
 * text-shaped suggestion on a non-text column, or a date `generalize` on a
 * column that's neither date- nor text-shaped, downgrades to null-out
 * (type-preserving for any type).
 */
export function classifyColumn(name: string, dataType: string): PiiMatch | null {
  const normalized = name.toLowerCase();
  const text = isTextType(dataType);
  const date = isDateType(dataType);
  for (const rule of RULES) {
    if (rule.test.test(normalized)) {
      let transform = rule.transform;
      if (isTextShaped(transform) && !text) {
        // Text-shaped on a non-text column would change the type; redact instead.
        transform = "null-out";
      } else if (isDateGeneralize(transform) && !date && !text) {
        // Birth-year bucketing needs a date- or text-shaped value to parse.
        transform = "null-out";
      }
      return {
        category: rule.category,
        confidence: rule.confidence,
        suggestedTransform: transform,
      };
    }
  }
  return null;
}
