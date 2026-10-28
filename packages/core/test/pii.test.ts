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
  bytea: "U",
  uuid: "U",
  boolean: "B",
};

const column = (name: string, type: string): Column => ({
  name,
  type,
  category: CATEGORY[type] ?? "X",
});
const classify = (name: string, type: string) =>
  classifyColumn(column(name, type));

const CREDENTIALS = [
  "password",
  "passwd",
  "pwd",
  "password_hash",
  "passwd_hash",
  "pw_hash",
  "secret",
  "client_secret",
  "secret_key",
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth_token",
  "session_token",
  "bearer_token",
  "jwt",
  "api_key",
  "apikey",
  "private_key",
  "access_key",
  "signing_key",
  "secret_access_key",
  "encryption_key",
  "license_key",
];

describe("classifyColumn: high-confidence categories", () => {
  // protects=a column named for a password, secret, token or API key, or for its hash, is suggested as a high-confidence credential, fully redacted where it is text and nulled out where it is bytes, whatever the name's case, and a credential named for personal data is still a credential;
  // fails_when=one of the 25 names (the issue's 22, jwt, encryption_key and license_key), its upper or capitalized form, or its camelCase form matches no rule or another category, or gets another mask; a credential's hash or digest goes unflagged; the credential rule goes after the personal-data rules;
  // no_claim=names outside the list or the policy page's label; the types are catalog records built here, not read from Postgres
  it("flags credentials → full-redact on text, null-out on bytea", () => {
    const capitalized = (n: string) =>
      n.replace(
        /(^|_)([a-z])/g,
        (_, b: string, c: string) => b + c.toUpperCase(),
      );
    const camel = (n: string) =>
      n.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    for (const n of CREDENTIALS) {
      for (const name of [n, n.toUpperCase(), capitalized(n), camel(n)]) {
        expect(classify(name, "text"), name).toEqual({
          category: "credential",
          confidence: "high",
          suggested: "full-redact",
        });
        expect(classify(name, "bytea"), name).toEqual({
          category: "credential",
          confidence: "high",
          suggested: "null-out",
        });
      }
    }
    // A hash of one, as auth libraries store it (Rails' password_digest).
    for (const n of [
      "password_digest",
      "pwd_hash",
      "secret_hash",
      "token_hash",
      "api_key_hash",
    ]) {
      expect(classify(n, "text")?.category, n).toBe("credential");
    }
    // First in the rules: a token sent to an email or a phone is a secret.
    for (const n of ["email_verification_token", "phone_auth_token"]) {
      expect(classify(n, "text")?.category, n).toBe("credential");
    }
  });

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

  // protects=a credential is suggested only on a type that can hold one, a string or bytes (bytea, uuid), so a flag or a count named for one isn't nulled out;
  // fails_when=a boolean or integer column named for a credential is suggested, or a uuid token isn't;
  // no_claim=types other than these four; the type categories are this file's table, not read from pg_type
  it("flags a credential only on string and binary types", () => {
    expect(classify("has_password", "boolean")).toBeNull();
    expect(classify("is_secret", "boolean")).toBeNull();
    expect(classify("api_key", "integer")).toBeNull();
    expect(classify("session_token", "uuid")).toEqual({
      category: "credential",
      confidence: "high",
      suggested: "null-out",
    });
  });
});

describe("classifyColumn: camelCase names", () => {
  // protects=a camelCase name is read as its words, so every rule matches it as it matches the snake_case name, whatever the words before the credential or personal data;
  // fails_when=stripeApiKey, userPassword, githubToken, webhookSecret, an acronym (APIKey, userAPIKey, IPAddress) or userEmail matches no rule or another category;
  // no_claim=names that join their words with neither `_` nor a capital (stripeapikey), which still read as one word
  it("reads a camelCase name as its words", () => {
    for (const n of [
      "stripeApiKey",
      "userPassword",
      "githubToken",
      "webhookSecret",
      "APIKey",
      "userAPIKey",
    ]) {
      expect(classify(n, "text")?.category, n).toBe("credential");
    }
    expect(classify("userEmail", "text")?.category).toBe("email");
    expect(classify("IPAddress", "inet")?.category).toBe("ip");
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

  // protects=a key, hash or salt that isn't a secret, and a column about a token or password rather than holding one, gets no suggestion;
  // fails_when=the credential rule matches a bare key, hash or salt, a word that only starts with one (secretary, tokens_used), or a name with a word after the credential's;
  // no_claim=that every name of that kind is left alone: only these ten are checked, the issue's nine and password_changed_at from the rule's comment
  it("doesn't flag a bare key, hash or salt, or a name about a credential", () => {
    for (const n of [
      "key",
      "hash",
      "salt",
      "cache_key",
      "commit_hash",
      "partition_key",
      "tokens_used",
      "token_count",
      "secretary",
      "password_changed_at",
    ]) {
      expect(classify(n, "text"), n).toBeNull();
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
      ...CREDENTIALS,
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

  // protects=on the quickstart's tables, before any mask, the scan suggests api_keys.secret as a credential, alongside the customers' name, email and phone it suggested before;
  // fails_when=the secret goes unsuggested, a column suggested before drops out, or another quickstart column (a ticket's body, a key's service) is suggested;
  // no_claim=that the catalog matches seed.sql: it is a copy of its tables written here, not introspected from Postgres (the quickstart's e2e test runs the scan on the loaded seed)
  it("suggests the quickstart's API key secret, with its personal data", () => {
    const quickstart: CatalogSnapshot = {
      relations: [
        {
          schema: "public",
          name: "customers",
          kind: "table",
          columns: [
            column("id", "integer"),
            column("name", "text"),
            column("email", "text"),
            column("phone", "text"),
            column("plan", "text"),
            column("created_at", "date"),
          ],
        },
        {
          schema: "public",
          name: "support_tickets",
          kind: "table",
          columns: [
            column("id", "integer"),
            column("customer_id", "integer"),
            column("subject", "text"),
            column("body", "text"),
            column("status", "text"),
          ],
        },
        {
          schema: "public",
          name: "api_keys",
          kind: "table",
          columns: [
            column("id", "integer"),
            column("service", "text"),
            column("secret", "text"),
          ],
        },
      ],
      routines: [],
    };
    const found = exposureScan(DatabasePolicySchema.parse({}), quickstart).map(
      (s) => [s.table, s.column, s.match.category, s.match.suggested],
    );
    expect(found).toEqual([
      ["public.customers", "name", "name", "full-redact"],
      ["public.customers", "email", "email", "full-redact"],
      ["public.customers", "phone", "phone", { t: "partial", keepEnd: 4 }],
      ["public.api_keys", "secret", "credential", "full-redact"],
    ]);
  });
});
