// The exposure scan: which columns look like personal data, judged by name
// and type from the catalog snapshot alone, never by reading a value. It
// suggests; a person confirms in the policy grid. A false positive gets
// unchecked, a miss gets masked by hand. Ported from the old app's
// pii-heuristics.

import type {
  AccessLevel,
  CatalogSnapshot,
  Column,
  DatabasePolicy,
  MaskRuleInput,
} from "@midplane/protocol";
import { relationKey } from "./catalog.ts";
import { accessLevel } from "./decide.ts";

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
  /** A mask the column's type accepts; the person may pick another. */
  suggested: MaskRuleInput;
}

interface Rule {
  category: PiiCategory;
  test: RegExp;
  confidence: PiiConfidence;
}

// Matched against the lowercased name, most specific first: the first hit
// wins, so "ssn" beats a generic "name" substring.
const RULES: Rule[] = [
  {
    category: "ssn",
    test: /(^|_)ssn($|_)|social_secur|(^|_)tin($|_)|tax_?id/,
    confidence: "high",
  },
  {
    category: "credit_card",
    test: /credit_?card|card_?number|(^|_)ccnum|cc_?number|card_?no($|_)|(^|_)pan($|_)/,
    confidence: "high",
  },
  {
    category: "email",
    test: /(^|_)e_?mail($|_)|email_addr|mail_address/,
    confidence: "high",
  },
  {
    category: "phone",
    test: /(^|_)phone($|_)|phone_?number|mobile_?(no|number)?|(^|_)tel($|_)|telephone|(^|_)fax($|_)/,
    confidence: "high",
  },
  {
    category: "dob",
    test: /date_?of_?birth|(^|_)dob($|_)|birth_?date|birthday/,
    confidence: "high",
  },
  // Before "address", so "ip_address" is an IP, not a street address.
  { category: "ip", test: /ip_?address|(^|_)ip($|_)/, confidence: "low" },
  {
    category: "address",
    test: /(^|_)address($|_)|street_?(addr|address|name)?|postal_?code|(^|_)zip(code)?($|_)/,
    confidence: "medium",
  },
  {
    category: "name",
    test: /first_?name|last_?name|full_?name|(^|_)fname($|_)|(^|_)lname($|_)|surname|given_?name|family_?name/,
    confidence: "medium",
  },
  // A bare "name" is a weak signal (table_name, file_name, display_name).
  { category: "name", test: /(^|_)name($|_)/, confidence: "low" },
];

// pg_type.typcategory, the same gate the core's transforms use.
const STRING = "S";
const DATETIME = "D";

/** Date and timestamp, but not time of day, where a year means nothing. */
function isDate(column: Column): boolean {
  return (
    column.category === DATETIME && /^(date|timestamp)\b/.test(column.type)
  );
}

/**
 * A default the column's type accepts. Identifiers and free-form personal
 * data are fully redacted; a phone keeps its last four digits; a birth date
 * keeps its year. Anything else falls back to `null-out`, which fits every
 * type. Never `noise`: it is redrawn on every read and breaks joins, so it is
 * only ever a person's deliberate choice.
 */
function suggest(category: PiiCategory, column: Column): MaskRuleInput {
  const text = column.category === STRING;
  switch (category) {
    case "phone":
      return text ? { t: "partial", keepEnd: 4 } : "null-out";
    case "dob":
      return isDate(column)
        ? { t: "generalize", granularity: "year" }
        : "null-out";
    case "ssn":
    case "credit_card":
    case "email":
    case "name":
    case "address":
    case "ip":
      return text ? "full-redact" : "null-out";
  }
}

/** Whether a column looks like personal data, and what to mask it with. */
export function classifyColumn(column: Column): PiiMatch | null {
  const name = column.name.toLowerCase();
  for (const rule of RULES) {
    if (rule.test.test(name)) {
      return {
        category: rule.category,
        confidence: rule.confidence,
        suggested: suggest(rule.category, column),
      };
    }
  }
  return null;
}

export interface ExposureSuggestion {
  /** The policy's key for the table, `schema.table`. */
  table: string;
  column: string;
  type: string;
  match: PiiMatch;
  /** What the policy lets agents do with the table. */
  access: AccessLevel;
  /**
   * The table has a mask entry but this column has none: it is new since the
   * last review and fully redacted until someone reviews it.
   */
  unreviewed: boolean;
}

const SYSTEM = new Set(["pg_catalog", "information_schema"]);
const MASKABLE = new Set(["table", "partitioned_table", "foreign_table"]);

/**
 * Columns that look like personal data and have no mask rule of their own.
 * Only tables are scanned: partitions take their parent's masks, and views
 * resolve through their definitions.
 */
export function exposureScan(
  policy: DatabasePolicy,
  catalog: CatalogSnapshot,
): ExposureSuggestion[] {
  const out: ExposureSuggestion[] = [];
  for (const r of catalog.relations) {
    if (SYSTEM.has(r.schema) || !MASKABLE.has(r.kind) || r.parent) continue;
    const table = relationKey(r.schema, r.name);
    const entry = policy.masks[table];
    for (const c of r.columns) {
      if (entry?.[c.name] !== undefined) continue;
      const match = classifyColumn(c);
      if (!match) continue;
      out.push({
        table,
        column: c.name,
        type: c.type,
        match,
        access: accessLevel(policy, r.schema, r.name),
        unreviewed: entry !== undefined,
      });
    }
  }
  return out;
}
