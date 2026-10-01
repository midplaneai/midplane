// Catalog redaction: a view definition leaves the gateway with every literal
// replaced by a placeholder of its kind and nothing else changed, or not at
// all. The agreement test proves no evaluation changes; these pin the rules.

import { loadCorpus } from "@midplane/corpus";
import { type CatalogSnapshot, DatabasePolicySchema } from "@midplane/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import {
  evaluate,
  loadParser,
  redactCatalog,
  redactDefinition,
  unredactedDefinitions,
  withheldViews,
} from "../src/index.ts";

beforeAll(async () => {
  await loadParser();
});

/** Every distinct catalog the corpus uses. */
const catalogs = [...new Set(loadCorpus().map((c) => c.input.catalog))];
const withView = (name: string) =>
  catalogs.find((c) =>
    c.relations.some((r) => r.name === name),
  ) as CatalogSnapshot;
/** Hand-written definitions with literals of every kind. */
const seeded = withView("vip_accounts");
/** Definitions as Postgres 17 prints them, introspected by the gateway. */
const printed = withView("v_quotes");

/** The markers both catalogs seed in their view literals. */
const SECRETS = ["s3cr3t", "4711", "47.11"];
/** Bit strings only the hand-written catalog can spell as constants. */
const BITS = ["10100111", "1F2E"];

function redacted(sql: string): string {
  const out = redactDefinition(sql);
  if (!out.ok) throw new Error(out.reason);
  return out.sql;
}

describe("redactDefinition", () => {
  it("replaces each kind of literal with a placeholder of its kind", () => {
    expect(
      redacted(
        "SELECT 'a', E'b\\n', U&'\\0041', $$d$$, B'1010', X'1F', 42, -7, 1.5, 9999999999, 1e10 FROM t",
      ),
    ).toBe("SELECT '?', '?', '?', '?', b'', b'', 0, 0, 0.0, 0.0, 0.0 FROM t");
  });

  it("keeps NULL, booleans, type modifiers, casts and names", () => {
    expect(
      redacted(
        "SELECT NULL, true, false, 'x'::varchar(10), 1::numeric(10,2), interval '1' day, t.a FROM s.t",
      ),
    ).toBe(
      "SELECT NULL, true, false, CAST('?' AS varchar(10)), CAST(0 AS numeric(10, 2)), CAST('?' AS interval day), t.a FROM s.t",
    );
  });

  it("keeps ORDER BY, GROUP BY and DISTINCT ON positions, and replaces every other integer", () => {
    expect(
      redacted(
        "SELECT a, b, sum(c) OVER (ORDER BY 1) FROM t GROUP BY 1, ROLLUP (2) ORDER BY 1, a + 4711 LIMIT 5 OFFSET 3",
      ),
    ).toBe(
      "SELECT a, b, sum(c) OVER (ORDER BY 0) FROM t GROUP BY 1, ROLLUP (2) ORDER BY 1, a + 0 LIMIT 0 OFFSET 0",
    );
    expect(redacted("SELECT DISTINCT ON (2) a, b FROM t ORDER BY 2, 1")).toBe(
      "SELECT DISTINCT ON (2) a, b FROM t ORDER BY 2, 1",
    );
    expect(redacted("SELECT a FROM t UNION SELECT b FROM u ORDER BY 1")).toBe(
      "SELECT a FROM t UNION SELECT b FROM u ORDER BY 1",
    );
    expect(
      redacted("SELECT a FROM (SELECT a FROM t ORDER BY 1 LIMIT 10) s"),
    ).toBe("SELECT a FROM ( SELECT a FROM t ORDER BY 1 LIMIT 0 ) AS s");
  });

  it("keeps EXTRACT fields and NORMALIZE forms Postgres knows, which are keywords", () => {
    expect(
      redacted(
        "SELECT EXTRACT(year FROM at), extract('epoch' FROM at), date_part('month', at) FROM t",
      ),
    ).toBe(
      "SELECT EXTRACT(YEAR FROM at), EXTRACT(EPOCH FROM at), date_part('?', at) FROM t",
    );
    expect(
      redacted("SELECT normalize(a, NFKC), a IS NFC NORMALIZED FROM t"),
    ).toBe("SELECT normalize(a, NFKC), a IS NFC NORMALIZED FROM t");
    // A name Postgres doesn't know is a string like any other.
    const view = (definition: string): CatalogSnapshot => ({
      relations: [
        { schema: "public", name: "v", kind: "view", columns: [], definition },
      ],
      routines: [],
    });
    expect(
      unredactedDefinitions(view("SELECT EXTRACT(s3cr3t FROM at) FROM t")),
    ).toEqual(["public.v"]);
    expect(
      unredactedDefinitions(view("SELECT EXTRACT(week FROM at) FROM t")),
    ).toEqual([]);
    expect(
      unredactedDefinitions(view("SELECT extract_week('year') FROM t")),
    ).toEqual(["public.v"]);
  });

  it("withholds what pgsql-deparser can't print faithfully, as Postgres prints it", () => {
    // A quoted "bit" deparses as the SQL keyword, which means bit(1); WITH
    // TIES is dropped. Either would change the view, so neither is sent.
    for (const sql of [
      "SELECT id, bits = '1010'::\"bit\" AS b FROM t",
      "SELECT id FROM t ORDER BY amount FETCH FIRST (4711) ROWS WITH TIES",
    ]) {
      expect(redactDefinition(sql)).toEqual({
        ok: false,
        reason: "it could not be printed back faithfully",
      });
    }
  });

  it("is idempotent", () => {
    for (const r of [...seeded.relations, ...printed.relations]) {
      if (!r.definition) continue;
      const once = redacted(r.definition);
      expect(redacted(once), r.name).toBe(once);
    }
  });

  it("refuses anything but one SELECT", () => {
    for (const sql of [
      "SELECT 1; SELECT 2",
      "INSERT INTO t VALUES (1)",
      "not sql",
      "",
    ]) {
      expect(redactDefinition(sql)).toEqual({
        ok: false,
        reason: "it is not a single SELECT",
      });
    }
  });
});

describe("redactCatalog", () => {
  it("leaves none of the seeded secrets in either seeded catalog", () => {
    for (const [c, markers] of [
      [seeded, [...SECRETS, ...BITS]],
      [printed, SECRETS],
    ] as const) {
      const before = JSON.stringify(c);
      for (const s of markers) expect(before).toContain(s);
      const { catalog, withheld } = redactCatalog(c);
      expect(withheld).toEqual([]);
      const after = JSON.stringify(catalog);
      for (const s of markers) expect(after).not.toContain(s);
    }
  });

  it("redacts every corpus catalog completely and withholds nothing", () => {
    for (const c of catalogs) {
      const { catalog, withheld } = redactCatalog(c);
      expect(withheld).toEqual([]);
      expect(unredactedDefinitions(catalog)).toEqual([]);
      // Only definitions change: names, types, kinds, parents, routines stay.
      const strip = (s: CatalogSnapshot) => ({
        ...s,
        relations: s.relations.map(({ definition: _, ...r }) => r),
      });
      expect(strip(catalog)).toEqual(strip(c));
    }
  });

  it("names every definition that still carries a literal, and no other", () => {
    // These two hold integers only as positions, which aren't values.
    const positionsOnly = ["public.rolled_up", "public.latest_event"];
    const views = seeded.relations
      .filter((r) => r.definition)
      .map((r) => `${r.schema}.${r.name}`)
      .filter((k) => !positionsOnly.includes(k));
    expect(views).toHaveLength(13);
    expect(unredactedDefinitions(seeded)).toEqual(views);
  });

  it("withholds a definition it can't redact, and simulation then fails closed", () => {
    const catalog: CatalogSnapshot = {
      relations: [
        {
          schema: "public",
          name: "t",
          kind: "table",
          columns: [{ name: "a", type: "integer", category: "N" }],
        },
        {
          schema: "public",
          name: "odd",
          kind: "view",
          columns: [{ name: "a", type: "integer", category: "N" }],
          definition: "SELECT a FROM t; SELECT 's3cr3t'",
        },
        {
          schema: "public",
          name: "fine",
          kind: "materialized_view",
          columns: [{ name: "a", type: "integer", category: "N" }],
          definition: "SELECT a FROM t WHERE a = 4711",
        },
        {
          schema: "pg_catalog",
          name: "pg_tables",
          kind: "view",
          columns: [{ name: "tablename", type: "name", category: "S" }],
        },
      ],
      routines: [{ schema: "public", name: "f", kind: "function" }],
    };
    expect(unredactedDefinitions(catalog)).toEqual([
      "public.odd",
      "public.fine",
    ]);
    const { catalog: out, withheld } = redactCatalog(catalog);
    expect(withheld).toEqual([
      { schema: "public", name: "odd", reason: "it is not a single SELECT" },
    ]);
    expect(JSON.stringify(out)).not.toContain("s3cr3t");
    expect(JSON.stringify(out)).not.toContain("4711");
    expect(out.relations[1]).not.toHaveProperty("definition");
    expect(out.relations[2]?.definition).toBe("SELECT a FROM t WHERE a = 0");
    expect(out.routines).toEqual(catalog.routines);
    expect(unredactedDefinitions(out)).toEqual([]);
    // System views never have definitions and aren't counted as withheld.
    expect(withheldViews(out)).toEqual(["public.odd"]);

    const e = evaluate({
      sql: "SELECT a FROM odd",
      databaseId: "main",
      policy: DatabasePolicySchema.parse({ table_access: { default: "read" } }),
      catalog: out,
      caller: {
        sub: "u",
        client_id: "c",
        grant_id: "g",
        scopes: ["db:main:read"],
      },
      tainted: false,
      intent: "",
    });
    expect(e.verdict === "deny" && e.rule).toBe("unresolved");
    expect(e.verdict === "deny" && e.reason).toContain(
      "has no definition in the catalog snapshot",
    );
  });
});
