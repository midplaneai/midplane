// PII classification heuristics (design D1 scan). Pure name+type rules — these
// pins document what the assistive scan flags and the default transform it
// suggests. False positives are acceptable (the user confirms); these tests pin
// the obvious hits, the confidence tiers, and the type-gated suggestions.

import { describe, expect, it } from "vitest";

import { classifyColumn } from "../src/lib/pii-heuristics.ts";

describe("classifyColumn: high-confidence categories", () => {
  it("flags email columns → full-redact", () => {
    for (const n of ["email", "user_email", "email_address", "contact_email", "billing_email"]) {
      const m = classifyColumn(n, "text");
      expect(m).toMatchObject({ category: "email", confidence: "high", suggestedTransform: "full-redact" });
    }
  });

  it("flags ssn / tax id → partial{keepEnd:4} on text columns", () => {
    for (const n of ["ssn", "social_security_number", "tax_id", "tin"]) {
      const m = classifyColumn(n, "text");
      expect(m).toMatchObject({ category: "ssn", confidence: "high" });
      expect(m?.suggestedTransform).toEqual({ t: "partial", keepEnd: 4 });
    }
  });

  it("flags phone → partial{keepEnd:4}", () => {
    for (const n of ["phone", "phone_number", "mobile_number", "telephone", "fax"]) {
      const m = classifyColumn(n, "varchar");
      expect(m?.category).toBe("phone");
      expect(m?.suggestedTransform).toEqual({ t: "partial", keepEnd: 4 });
    }
  });

  it("flags credit card → partial{keepEnd:4}", () => {
    for (const n of ["credit_card", "card_number", "cc_number", "pan"]) {
      const m = classifyColumn(n, "text");
      expect(m?.category).toBe("credit_card");
      expect(m?.suggestedTransform).toEqual({ t: "partial", keepEnd: 4 });
    }
  });

  it("flags date of birth → generalize{year} on date columns (analytics survive)", () => {
    for (const n of ["dob", "date_of_birth", "birth_date", "birthday"]) {
      const m = classifyColumn(n, "date");
      expect(m?.category).toBe("dob");
      expect(m?.suggestedTransform).toEqual({ t: "generalize", granularity: "year" });
    }
    // timestamp columns also generalize.
    expect(classifyColumn("dob", "timestamp with time zone")?.suggestedTransform).toEqual({
      t: "generalize",
      granularity: "year",
    });
    // A dob stored as text has no type-valid generalize → null-out fallback.
    expect(classifyColumn("dob", "text")?.suggestedTransform).toBe("null-out");
  });
});

describe("classifyColumn: confidence tiers + ambiguity", () => {
  it("names are medium (first/last/full) but bare 'name' is low", () => {
    expect(classifyColumn("first_name", "text")).toMatchObject({ category: "name", confidence: "medium" });
    expect(classifyColumn("last_name", "text")?.confidence).toBe("medium");
    // Bare/derived names: weak signal — flagged low so the UI de-emphasizes them.
    expect(classifyColumn("name", "text")?.confidence).toBe("low");
    expect(classifyColumn("display_name", "text")?.confidence).toBe("low");
  });

  it("address is medium; ip is low", () => {
    expect(classifyColumn("street_address", "text")?.category).toBe("address");
    expect(classifyColumn("zip_code", "text")?.category).toBe("address");
    expect(classifyColumn("ip_address", "inet")?.confidence).toBe("low");
  });
});

describe("classifyColumn: type-gate for type-changing transforms", () => {
  it("downgrades a text suggestion → null-out for a non-text column", () => {
    // An ssn stored as a bigint can't `partial` (text-only); a text token would
    // change the column's type, so suggest null-out (type-preserving).
    expect(classifyColumn("ssn", "bigint")).toMatchObject({
      category: "ssn",
      suggestedTransform: "null-out",
    });
    expect(classifyColumn("phone", "integer")?.suggestedTransform).toBe("null-out");
    // A full-redact category on a non-text column also downgrades to null-out.
    expect(classifyColumn("ip_address", "inet")?.suggestedTransform).toBe("null-out");
  });

  it("keeps partial{keepEnd:4} for text-like types", () => {
    expect(classifyColumn("ssn", "character varying")?.suggestedTransform).toEqual({ t: "partial", keepEnd: 4 });
    expect(classifyColumn("phone", "varchar")?.suggestedTransform).toEqual({ t: "partial", keepEnd: 4 });
  });
});

describe("classifyColumn: non-PII columns are not flagged", () => {
  it("returns null for plainly non-PII columns", () => {
    for (const n of ["id", "user_id", "created_at", "updated_at", "status", "count", "total", "is_active", "price"]) {
      expect(classifyColumn(n, "integer")).toBeNull();
    }
  });
});
