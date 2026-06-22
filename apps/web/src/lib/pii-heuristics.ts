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

import type { MaskTransform } from "@midplane-cloud/db/policy";

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
  suggestedTransform: MaskTransform;
}

// Ordered most-specific → least-specific; the first match wins so "ssn" beats a
// generic "name" substring and "email" beats nothing. Each rule carries the
// confidence and a default transform. A text-token transform (keep-last-4 or
// full-redact) on a NON-text column would silently change the column's type, so
// on such a column the suggestion downgrades to null-out (type-preserving — see
// classifyColumn).
interface Rule {
  category: PiiCategory;
  test: RegExp;
  confidence: PiiConfidence;
  transform: MaskTransform;
}

// Column names are normalized to lower snake/word form before matching.
const RULES: Rule[] = [
  { category: "ssn", test: /(^|_)ssn($|_)|social_secur|(^|_)tin($|_)|tax_?id/, confidence: "high", transform: "keep-last-4" },
  { category: "credit_card", test: /credit_?card|card_?number|(^|_)ccnum|cc_?number|card_?no(^|$|_)|(^|_)pan($|_)/, confidence: "high", transform: "keep-last-4" },
  { category: "email", test: /(^|_)e_?mail($|_)|email_addr|mail_address/, confidence: "high", transform: "full-redact" },
  { category: "phone", test: /(^|_)phone($|_)|phone_?number|mobile_?(no|number)?|(^|_)tel($|_)|telephone|(^|_)fax($|_)/, confidence: "high", transform: "keep-last-4" },
  { category: "dob", test: /date_?of_?birth|(^|_)dob($|_)|birth_?date|birthday/, confidence: "high", transform: "full-redact" },
  // Before "address" so "ip_address" classifies as ip, not a street address.
  { category: "ip", test: /ip_?address|(^|_)ip($|_)/, confidence: "low", transform: "full-redact" },
  { category: "address", test: /(^|_)address($|_)|street_?(addr|address|name)?|postal_?code|(^|_)zip(code)?($|_)/, confidence: "medium", transform: "full-redact" },
  { category: "name", test: /first_?name|last_?name|full_?name|(^|_)fname($|_)|(^|_)lname($|_)|surname|given_?name|family_?name/, confidence: "medium", transform: "full-redact" },
  // Bare "name" is a weak signal (table_name, file_name, display_name): low.
  { category: "name", test: /(^|_)name($|_)/, confidence: "low", transform: "full-redact" },
];

// Postgres data types the text-token transforms can operate on (text-like). On
// anything else, a keep-last-4 / full-redact suggestion downgrades to null-out
// (type-preserving), mirroring the picker's type-gate and the engine's text-only
// keep-last-4.
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

/**
 * Classify a column as likely PII from its name + Postgres data type, or null.
 * The match is the first (most-specific) rule whose pattern hits the normalized
 * column name. A text-token suggestion (keep-last-4 / full-redact) on a non-text
 * column downgrades to null-out, so the suggestion is always type-valid.
 */
export function classifyColumn(name: string, dataType: string): PiiMatch | null {
  const normalized = name.toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(normalized)) {
      let transform = rule.transform;
      // A text-token transform on a non-text column would change the column's
      // type; null-out is type-preserving for any type, so prefer it there.
      if (
        !isTextType(dataType) &&
        (transform === "keep-last-4" || transform === "full-redact")
      ) {
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
