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
  /** A sensible default mask rule for this category + column type; the user can
   *  change it in the picker. Always type-valid (see suggestTransform). */
  suggestedTransform: MaskRule;
}

// Ordered most-specific → least-specific; the first match wins so "ssn" beats a
// generic "name" substring and "email" beats nothing. Each rule carries the
// category + confidence; the suggested transform is derived from the category
// AND the column's type (see suggestTransform) so it's always type-valid.
interface Rule {
  category: PiiCategory;
  test: RegExp;
  confidence: PiiConfidence;
}

// Column names are normalized to lower snake/word form before matching.
const RULES: Rule[] = [
  { category: "ssn", test: /(^|_)ssn($|_)|social_secur|(^|_)tin($|_)|tax_?id/, confidence: "high" },
  { category: "credit_card", test: /credit_?card|card_?number|(^|_)ccnum|cc_?number|card_?no(^|$|_)|(^|_)pan($|_)/, confidence: "high" },
  { category: "email", test: /(^|_)e_?mail($|_)|email_addr|mail_address/, confidence: "high" },
  { category: "phone", test: /(^|_)phone($|_)|phone_?number|mobile_?(no|number)?|(^|_)tel($|_)|telephone|(^|_)fax($|_)/, confidence: "high" },
  { category: "dob", test: /date_?of_?birth|(^|_)dob($|_)|birth_?date|birthday/, confidence: "high" },
  // Before "address" so "ip_address" classifies as ip, not a street address.
  { category: "ip", test: /ip_?address|(^|_)ip($|_)/, confidence: "low" },
  { category: "address", test: /(^|_)address($|_)|street_?(addr|address|name)?|postal_?code|(^|_)zip(code)?($|_)/, confidence: "medium" },
  { category: "name", test: /first_?name|last_?name|full_?name|(^|_)fname($|_)|(^|_)lname($|_)|surname|given_?name|family_?name/, confidence: "medium" },
  // Bare "name" is a weak signal (table_name, file_name, display_name): low.
  { category: "name", test: /(^|_)name($|_)/, confidence: "low" },
];

// Postgres data types `partial` (text-only) and the text-token transforms can
// operate on. On anything else, a text suggestion downgrades to null-out
// (type-preserving), mirroring the picker's type-gate and the engine's text-only
// `partial`.
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

// Date/timestamp types `generalize: year` (the dob → birth-year suggestion) is
// valid for. time/timetz are excluded — year/month/day on a time-of-day is
// meaningless, so a dob stored that way falls back to null-out.
const DATE_TYPES = new Set([
  "date",
  "timestamp",
  "timestamp without time zone",
  "timestamp with time zone",
  "timestamptz",
]);

function isTextType(dataType: string): boolean {
  const t = dataType.toLowerCase().trim();
  return TEXT_TYPES.has(t) || t.startsWith("character") || t.startsWith("varchar");
}

function isDateType(dataType: string): boolean {
  const t = dataType.toLowerCase().trim();
  return DATE_TYPES.has(t) || t.startsWith("timestamp");
}

// Pick a type-valid default rule for a category. High-sensitivity identifiers
// (SSN, card) and free-form PII (email, name, address, ip) FULLY redact; phone
// keeps the last 4 (partial); a dob on a real date column generalizes to the
// birth YEAR (identifier dies, age-cohort analytics survive). Anything without
// a type-valid suggestion falls back to null-out (type-preserving for every
// type), so a suggested mask NEVER silently changes a column's type or rejects.
//
// The floor stays on the deterministic, redaction-flavored transforms. We do
// NOT auto-suggest `pseudonymize` (realistic fakes are a deliberate product
// choice for demo/staging DBs — the user opts in via the picker), and we NEVER
// suggest `noise`: it's the lone non-deterministic transform (breaks joins /
// grouping by design), so it must never be a default a scan nudges toward.
function suggestTransform(category: PiiCategory, dataType: string): MaskRule {
  const text = isTextType(dataType);
  switch (category) {
    // Highest-sensitivity identifiers default to FULL redaction. Revealing
    // even the last 4 of a card or SSN is a needless leak for a
    // scan-suggested default — the user can still dial down to `partial` in
    // the picker if they want the trailing digits.
    case "ssn":
    case "credit_card":
      return text ? "full-redact" : "null-out";
    // Phone keeps the last 4 (partial): lower sensitivity, and the trailing
    // digits aid recognition ("is this the right record?") without exposing
    // the number.
    case "phone":
      return text ? { t: "partial", keepEnd: 4 } : "null-out";
    case "dob":
      return isDateType(dataType) ? { t: "generalize", granularity: "year" } : "null-out";
    case "email":
    case "name":
    case "address":
    case "ip":
      return text ? "full-redact" : "null-out";
  }
}

/**
 * Classify a column as likely PII from its name + Postgres data type, or null.
 * The match is the first (most-specific) rule whose pattern hits the normalized
 * column name; the suggested transform is then derived from the category and the
 * column's type, so it is always type-valid (the engine fail-closes on an
 * out-of-domain transform).
 */
export function classifyColumn(name: string, dataType: string): PiiMatch | null {
  const normalized = name.toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(normalized)) {
      return {
        category: rule.category,
        confidence: rule.confidence,
        suggestedTransform: suggestTransform(rule.category, dataType),
      };
    }
  }
  return null;
}
