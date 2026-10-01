// The exposure scan's name heuristics, ported from the old app's tests: the
// obvious hits, the confidence tiers, and suggestions the column's type
// accepts. False positives are fine (a person confirms each suggestion).

import {
  type CatalogSnapshot,
  type Column,
  DatabasePolicySchema,
} from "@midplane/protocol";
import { describe, expect, it } from "vitest";
import { classifyColumn, exposureScan } from "../src/index.ts";

// Types as the catalog records them, with their pg_type.typcategory.
const CATEGORY: Record<string, string> = {
  text: "S",
  "character varying": "S",
  "character varying(20)": "S",
  citext: "S",
  bigint: "N",
  integer: "N",
  numeric: "N",
  "double precision": "N",
  date: "D",
  "timestamp with time zone": "D",
  "timestamp(3) without time zone": "D",
  "time without time zone": "D",
  inet: "I",
};

const column = (name: string, type: string): Column => ({
  name,
  type,
  category: CATEGORY[type] ?? "X",
});
const classify = (name: string, type: string) =>
  classifyColumn(column(name, type));

describe("classifyColumn: high-confidence categories", () => {
  it("flags email columns → full-redact", () => {
    for (const n of [
      "email",
      "user_email",
      "email_address",
      "contact_email",
      "billing_email",
      "Email",
    ]) {
      expect(classify(n, "text")).toMatchObject({
        category: "email",
        confidence: "high",
        suggested: "full-redact",
      });
    }
  });

  it("flags ssn and tax id → full-redact on text", () => {
    for (const n of ["ssn", "social_security_number", "tax_id", "tin"]) {
      expect(classify(n, "text")).toMatchObject({
        category: "ssn",
        confidence: "high",
        suggested: "full-redact",
      });
    }
  });

  it("flags phone → partial, keeping the last four", () => {
    for (const n of [
      "phone",
      "phone_number",
      "mobile_number",
      "telephone",
      "fax",
    ]) {
      const m = classify(n, "character varying(20)");
      expect(m?.category).toBe("phone");
      expect(m?.suggested).toEqual({ t: "partial", keepEnd: 4 });
    }
  });

  it("flags credit cards → full-redact", () => {
    for (const n of [
      "credit_card",
      "card_number",
      "cc_number",
      "pan",
      "card_no",
    ]) {
      const m = classify(n, "text");
      expect(m?.category).toBe("credit_card");
      expect(m?.suggested).toBe("full-redact");
    }
  });

  it("flags date of birth → the year, on dates and timestamps only", () => {
    for (const n of ["dob", "date_of_birth", "birth_date", "birthday"]) {
      const m = classify(n, "date");
      expect(m?.category).toBe("dob");
      expect(m?.suggested).toEqual({ t: "generalize", granularity: "year" });
    }
    for (const t of [
      "timestamp with time zone",
      "timestamp(3) without time zone",
    ]) {
      expect(classify("dob", t)?.suggested).toEqual({
        t: "generalize",
        granularity: "year",
      });
    }
    // A time of day has no year, and text has no generalize.
    expect(classify("dob", "time without time zone")?.suggested).toBe(
      "null-out",
    );
    expect(classify("dob", "text")?.suggested).toBe("null-out");
  });
});

describe("classifyColumn: confidence tiers", () => {
  it("full names are medium, a bare name is low", () => {
    expect(classify("first_name", "text")).toMatchObject({
      category: "name",
      confidence: "medium",
    });
    expect(classify("last_name", "text")?.confidence).toBe("medium");
    expect(classify("name", "text")?.confidence).toBe("low");
    expect(classify("display_name", "text")?.confidence).toBe("low");
  });

  it("addresses are medium, IPs low, and ip_address is an IP", () => {
    expect(classify("street_address", "text")?.category).toBe("address");
    expect(classify("zip_code", "text")?.category).toBe("address");
    expect(classify("ip_address", "inet")).toMatchObject({
      category: "ip",
      confidence: "low",
    });
  });
});

describe("classifyColumn: suggestions fit the column's type", () => {
  it("falls back to null-out where a text transform can't apply", () => {
    expect(classify("ssn", "bigint")).toMatchObject({
      category: "ssn",
      suggested: "null-out",
    });
    expect(classify("phone", "integer")?.suggested).toBe("null-out");
    expect(classify("ip_address", "inet")?.suggested).toBe("null-out");
  });

  it("treats every string-category type as text", () => {
    expect(classify("email", "citext")?.suggested).toBe("full-redact");
    expect(classify("ssn", "character varying")?.suggested).toBe("full-redact");
  });
});

describe("classifyColumn: what it leaves alone", () => {
  it("doesn't flag plainly non-personal columns", () => {
    for (const n of [
      "id",
      "user_id",
      "created_at",
      "updated_at",
      "status",
      "count",
      "total",
      "is_active",
      "price",
      "pineapple",
      "opinion",
    ]) {
      expect(classify(n, "integer"), n).toBeNull();
    }
  });

  it("never suggests noise, for any category or type", () => {
    const names = [
      "email",
      "ssn",
      "tax_id",
      "phone",
      "mobile_number",
      "credit_card",
      "card_number",
      "date_of_birth",
      "dob",
      "first_name",
      "last_name",
      "name",
      "street_address",
      "zip_code",
      "ip_address",
    ];
    for (const n of names) {
      for (const t of Object.keys(CATEGORY)) {
        const s = classify(n, t)?.suggested;
        if (s === undefined) continue;
        expect(typeof s === "string" ? s : s.t).not.toBe("noise");
      }
    }
  });
});

describe("exposureScan", () => {
  const catalog: CatalogSnapshot = {
    relations: [
      {
        schema: "public",
        name: "users",
        kind: "table",
        columns: [
          column("id", "integer"),
          column("email", "text"),
          column("phone", "text"),
          column("ssn", "text"),
        ],
      },
      {
        schema: "public",
        name: "events",
        kind: "partitioned_table",
        columns: [column("id", "bigint"), column("ip_address", "inet")],
      },
      {
        schema: "public",
        name: "events_2026",
        kind: "table",
        columns: [column("id", "bigint"), column("ip_address", "inet")],
        parent: { schema: "public", name: "events" },
      },
      {
        schema: "public",
        name: "user_emails",
        kind: "view",
        columns: [column("email", "text")],
        definition: "SELECT email FROM public.users",
      },
      {
        schema: "crm",
        name: "leads",
        kind: "foreign_table",
        columns: [column("first_name", "text")],
      },
      {
        schema: "information_schema",
        name: "columns",
        kind: "view",
        columns: [column("column_name", "text")],
      },
    ],
    routines: [],
  };

  it("suggests for tables only, and not for columns already decided", () => {
    const policy = DatabasePolicySchema.parse({
      table_access: { tables: { "public.users": "read" } },
      masks: { "public.users": { id: "none", ssn: "full-redact" } },
    });
    const found = exposureScan(policy, catalog).map((s) => [
      s.table,
      s.column,
      s.access,
      s.unreviewed,
    ]);
    expect(found).toEqual([
      // users has a mask entry: its unlisted columns are unreviewed.
      ["public.users", "email", "read", true],
      ["public.users", "phone", "read", true],
      ["public.events", "ip_address", "deny", false],
      ["crm.leads", "first_name", "deny", false],
    ]);
  });

  it("carries the suggestion and the column's type", () => {
    const policy = DatabasePolicySchema.parse({});
    const phone = exposureScan(policy, catalog).find(
      (s) => s.column === "phone",
    );
    expect(phone).toMatchObject({
      type: "text",
      unreviewed: false,
      match: {
        category: "phone",
        suggested: { t: "partial", keepEnd: 4 },
      },
    });
  });
});
