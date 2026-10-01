// What the cloud shows about masks: each base column's rule, and the columns
// of masked tables no one has reviewed.

import { type CatalogSnapshot, DatabasePolicySchema } from "@midplane/protocol";
import { beforeAll, expect, it } from "vitest";
import {
  evaluate,
  loadParser,
  maskLookup,
  unreviewedColumns,
} from "../src/index.ts";

beforeAll(async () => {
  await loadParser();
});

const col = (name: string, type = "text") => ({ name, type, category: "S" });
const catalog: CatalogSnapshot = {
  relations: [
    {
      schema: "public",
      name: "users",
      kind: "table",
      columns: [col("id", "integer"), col("email"), col("nickname")],
    },
    {
      schema: "public",
      name: "events",
      kind: "partitioned_table",
      columns: [col("id", "bigint"), col("ip")],
    },
    {
      schema: "public",
      name: "events_2026",
      kind: "table",
      columns: [col("id", "bigint"), col("ip")],
      parent: { schema: "public", name: "events" },
    },
    { schema: "public", name: "notes", kind: "table", columns: [col("body")] },
  ],
  routines: [],
};
const policy = DatabasePolicySchema.parse({
  masks: {
    "public.users": { id: "none", email: "full-redact" },
    "public.events": { id: "none", ip: "null-out" },
  },
});

it("gives each base column its rule, the unreviewed redacted", () => {
  const mask = maskLookup(policy, catalog);
  const at = (table: string, column: string) =>
    mask({ schema: "public", table, column });
  expect(at("users", "email")).toEqual({
    rule: "full-redact",
    unreviewed: false,
  });
  expect(at("users", "id")).toEqual({ rule: "none", unreviewed: false });
  expect(at("users", "nickname")).toEqual({
    rule: "full-redact",
    unreviewed: true,
  });
  // A partition takes its parent's masks.
  expect(at("events_2026", "ip")).toEqual({
    rule: "null-out",
    unreviewed: false,
  });
  expect(at("notes", "body")).toBeNull();
  expect(at("missing", "x")).toBeNull();
});

it("lists the columns of masked tables no one has reviewed", () => {
  expect(unreviewedColumns(policy, catalog)).toEqual([
    { table: "public.users", column: "nickname", type: "text" },
  ]);
});

it('says when a result passes through a mask, the Query log\'s "Fields hidden"', () => {
  const readable = DatabasePolicySchema.parse({
    ...policy,
    table_access: { default: "read_write" },
  });
  const masked = (sql: string) => {
    const e = evaluate({
      sql,
      databaseId: "main",
      policy: readable,
      catalog,
      caller: {
        sub: "u",
        client_id: "c",
        grant_id: "g",
        scopes: ["db:main:write"],
      },
      tainted: false,
      intent: "",
    });
    return { verdict: e.verdict, masked: e.effects.masked };
  };
  expect(masked("SELECT email FROM users")).toEqual({
    verdict: "allow",
    masked: true,
  });
  // Marked "none": reviewed and clear.
  expect(masked("SELECT id FROM users")).toEqual({
    verdict: "allow",
    masked: false,
  });
  // Unreviewed: redacted until someone reviews it.
  expect(masked("SELECT upper(nickname) AS n FROM users")).toEqual({
    verdict: "allow",
    masked: true,
  });
  // Through the parent's entry.
  expect(masked("SELECT ip FROM events_2026")).toEqual({
    verdict: "allow",
    masked: true,
  });
  expect(masked("SELECT body FROM notes")).toEqual({
    verdict: "allow",
    masked: false,
  });
  // Filtering on a masked column returns nothing masked.
  expect(masked("SELECT id FROM users WHERE email = 'x'")).toEqual({
    verdict: "allow",
    masked: false,
  });
  expect(
    masked("UPDATE users SET id = 2 WHERE id = 1 RETURNING email"),
  ).toEqual({ verdict: "allow", masked: true });
  expect(masked("DELETE FROM users")).toEqual({
    verdict: "deny",
    masked: false,
  });
});
