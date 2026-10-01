// Statement redaction for the audit push: a statement leaves the gateway with
// every literal a numbered parameter, every name the catalog doesn't know a
// placeholder, and no comments, or with no text at all. These pin the rules;
// the corpus pass shows nothing slips through on any statement the core has
// seen.

import { loadCorpus } from "@midplane/corpus";
import { parseSync } from "libpg-query";
import { beforeAll, describe, expect, it } from "vitest";
import {
  catalogNames,
  evaluate,
  loadParser,
  type RedactedStatement,
  redactStatement,
  unredactedStatement,
} from "../src/index.ts";
import { MAX_REDACTED_INPUT } from "../src/redact.ts";

beforeAll(async () => {
  await loadParser();
});

const NAMES = new Set([
  "public",
  "customers",
  "orders",
  "id",
  "name",
  "email",
  "total",
  "created_at",
  "customer_id",
]);

function text(sql: string, names: ReadonlySet<string> = NAMES): string {
  const out = redactStatement(sql, names);
  if (!out.ok) throw new Error(`withheld (${out.withheld}): ${sql}`);
  return out.sql;
}

describe("redactStatement", () => {
  it("replaces every literal with a parameter numbered in source order, and drops comments", () => {
    expect(
      text(
        "SELECT email FROM customers -- jane@acme.com\nWHERE email = 'jane@acme.com' /* x */ AND id > 4711 LIMIT 10",
      ),
    ).toBe("SELECT email FROM customers WHERE email = $1 AND id > $2 LIMIT $3");
    expect(
      text(
        "SELECT 'a', E'b\\n', U&'\\0041', $$d$$, B'1010', X'1F', 42, -7, 1.5, 9999999999, 1e10",
      ),
    ).toBe("SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11");
  });

  it("keeps NULL, booleans, type modifiers, positions and SQL keywords", () => {
    expect(
      text(
        "SELECT NULL, true, 'x'::varchar(10), date '2024-01-01', interval '1' day, EXTRACT(year FROM created_at), normalize(name, NFC) FROM customers ORDER BY 1 LIMIT ALL",
      ),
    ).toBe(
      // pgsql-deparser spells LIMIT ALL as LIMIT NULL, which Postgres reads alike.
      "SELECT NULL, true, CAST($1 AS varchar(10)), CAST($2 AS date), CAST($3 AS interval day), EXTRACT(YEAR FROM created_at), normalize(name, NFC) FROM customers ORDER BY 1 LIMIT NULL",
    );
  });

  it("writes: INSERT, ON CONFLICT, UPDATE, DELETE and RETURNING", () => {
    expect(
      text(
        "INSERT INTO orders (customer_id, total) VALUES (7, 19.99) ON CONFLICT (id) DO UPDATE SET total = excluded.total + 1 RETURNING id",
      ),
    ).toBe(
      "INSERT INTO orders (customer_id, total) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET total = excluded.total + $3 RETURNING id",
    );
    expect(
      text("UPDATE customers SET name = 'Jane Doe' WHERE id = 5 RETURNING id"),
    ).toBe("UPDATE customers SET name = $1 WHERE id = $2 RETURNING id");
    expect(
      text(
        "DELETE FROM orders WHERE created_at < now() - interval '30 days' AND customer_id IN (1, 2)",
      ),
    ).toBe(
      "DELETE FROM orders WHERE created_at < (now() - CAST($1 AS interval)) AND customer_id IN ($2, $3)",
    );
  });

  it("numbers a literal the tree holds twice once", () => {
    // A multi-column SET's subquery sits under each of its columns.
    expect(
      text(
        "UPDATE customers SET (name, email) = (SELECT name, email FROM customers WHERE id = 2) WHERE id = 1",
      ),
    ).toBe(
      "UPDATE customers SET (name, email) = (SELECT name, email FROM customers WHERE id = $1) WHERE id = $2",
    );
  });

  it("schema changes: CREATE TABLE [AS], CREATE INDEX, ALTER, RENAME, DROP, TRUNCATE", () => {
    expect(
      text(
        "CREATE TABLE notes (body text DEFAULT 'hi', CHECK (length(body) > 3))",
      ),
    ).toBe("CREATE TABLE _1 (_2 text DEFAULT $1, CHECK (length(_2) > $2))");
    expect(
      text("CREATE TABLE big AS SELECT * FROM orders WHERE total > 100"),
    ).toBe("CREATE TABLE _1 AS SELECT * FROM orders WHERE total > $1");
    expect(
      text("CREATE INDEX orders_total ON orders (total) WHERE total > 1000"),
    ).toBe("CREATE INDEX _1 ON orders (total) WHERE total > $1");
    expect(
      text("ALTER TABLE customers ALTER COLUMN name SET DEFAULT 'anon'"),
    ).toBe("ALTER TABLE customers ALTER COLUMN name SET DEFAULT $1");
    expect(text("ALTER TABLE customers RENAME COLUMN name TO full_name")).toBe(
      "ALTER TABLE customers RENAME COLUMN name TO _1",
    );
    expect(text("DROP TABLE customers, archive")).toBe(
      "DROP TABLE customers, _1",
    );
    expect(text("TRUNCATE orders")).toBe("TRUNCATE orders");
  });

  it("replaces names the catalog doesn't know, the same name the same placeholder", () => {
    // A value written where a name goes: the MySQL habit of double quotes.
    expect(text(`SELECT id FROM customers WHERE email = "jane@acme.com"`)).toBe(
      "SELECT id FROM customers WHERE email = _1",
    );
    expect(
      text(
        "SELECT c.email AS addr FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.name = 'x'",
      ),
    ).toBe(
      "SELECT _2.email AS _1 FROM customers AS _2 JOIN orders AS _3 ON _3.customer_id = _2.id WHERE _2.name = $1",
    );
    expect(
      text(
        "WITH big AS (SELECT id FROM orders WHERE total > 5) SELECT b.id FROM big b",
      ),
    ).toBe(
      "WITH _2 AS (SELECT id FROM orders WHERE total > $1) SELECT _1.id FROM _2 AS _1",
    );
    expect(
      text(
        "SELECT count(*) OVER w FROM customers WINDOW w AS (PARTITION BY name)",
      ),
    ).toBe(
      "SELECT count(*) OVER _1 FROM customers WINDOW _1 AS (PARTITION BY name)",
    );
    // Function, type and operator names are code, and stay.
    expect(text("SELECT lower(name)::text || 'x' FROM customers")).toBe(
      "SELECT (lower(name))::text || $1 FROM customers",
    );
  });

  it("without the catalog, keeps plain names and withholds quoted ones", () => {
    expect(redactStatement("SELECT a FROM t WHERE c = 'x'")).toEqual({
      ok: true,
      sql: "SELECT a FROM t WHERE c = $1",
      kinds: ["SelectStmt"],
    });
    expect(
      redactStatement(`SELECT a FROM t WHERE b = "jane@acme.com"`),
    ).toMatchObject({ ok: false, withheld: "check" });
  });

  it("redacts stacked statements one by one", () => {
    expect(text("SELECT 1; DROP TABLE customers")).toBe(
      "SELECT $1;\nDROP TABLE customers",
    );
  });

  it("names each statement's kind with its text, a write behind WITH as a write", () => {
    // Value: protects=a statement sent with text still says what kind it is, so `WITH … INSERT` isn't read as a read; fails_when=the ok branch drops kinds; why_new=kinds went only with withheld statements; seam=none
    expect(
      redactStatement(
        "WITH x AS (SELECT id FROM customers) INSERT INTO customers (id) SELECT id FROM x",
        NAMES,
      ),
    ).toMatchObject({ ok: true, kinds: ["InsertStmt"] });
    expect(
      redactStatement("SELECT 1; DROP TABLE customers", NAMES),
    ).toMatchObject({ ok: true, kinds: ["SelectStmt", "DropStmt"] });
  });

  it("gives statement kinds the core doesn't evaluate no text, only their kind", () => {
    const withheld = (sql: string): RedactedStatement =>
      redactStatement(sql, NAMES);
    expect(withheld("COPY customers TO '/tmp/leak.csv'")).toEqual({
      ok: false,
      withheld: "kind",
      kinds: ["CopyStmt"],
    });
    expect(withheld("ALTER ROLE bob WITH PASSWORD 'hunter2'")).toEqual({
      ok: false,
      withheld: "kind",
      kinds: ["AlterRoleStmt"],
    });
    expect(withheld("SELECT 1; SET ROLE postgres")).toEqual({
      ok: false,
      withheld: "kind",
      kinds: ["SelectStmt", "VariableSetStmt"],
    });
    expect(
      withheld(
        "MERGE INTO customers c USING orders o ON c.id = o.customer_id WHEN MATCHED THEN DELETE",
      ),
    ).toMatchObject({ ok: false, withheld: "kind" });
  });

  it("gives a statement that doesn't parse no text", () => {
    for (const sql of ["SELECT 'jane@acme.com", "not sql at all", "", ";"]) {
      expect(redactStatement(sql, NAMES)).toEqual({
        ok: false,
        withheld: "parse",
        kinds: [],
      });
    }
  });

  it("gives a statement it can't print back faithfully no text", () => {
    // pgsql-deparser drops TEMP from SELECT INTO.
    expect(
      redactStatement("SELECT id INTO TEMP scratch FROM customers", NAMES),
    ).toEqual({ ok: false, withheld: "check", kinds: ["SelectStmt"] });
  });

  it("is idempotent", () => {
    const once = text(
      "SELECT c.email FROM customers c WHERE c.name = 'x' AND c.id = 4 ORDER BY 1",
    );
    expect(text(once)).toBe(once);
  });
});

describe("unredactedStatement", () => {
  it("passes only text with no constant, small integers and catalog names quoted", () => {
    const names = new Set(["Order Items"]);
    const clean = (sql: string) => !unredactedStatement(sql, names);
    expect(clean("SELECT email FROM t WHERE id = $1")).toBe(true);
    expect(clean("SELECT a FROM t ORDER BY 1")).toBe(true);
    expect(clean("SELECT NULL, true FROM t")).toBe(true);
    expect(clean('SELECT "Order Items".a FROM "Order Items"')).toBe(true);
    expect(clean('SELECT a COLLATE "C", "left"(a, $1) FROM t')).toBe(true);
    expect(clean("SELECT email FROM t WHERE id = 4711")).toBe(false);
    // Small integers are values too, outside positions and type modifiers.
    expect(clean("SELECT email FROM t WHERE age = 42")).toBe(false);
    expect(clean("SELECT CAST(a AS varchar(10)) FROM t ORDER BY 1")).toBe(true);
    expect(clean("SELECT 'jane@acme.com'")).toBe(false);
    expect(clean("SELECT $$jane$$, E'x', B'1', X'1F', 1.5, U&'x'")).toBe(false);
    expect(clean('SELECT a FROM t WHERE b = "jane@acme.com"')).toBe(false);
    expect(clean('SELECT a FROM U&"d\\0061t"')).toBe(false);
    // Markers numbered past how many there are were the agent's own digits.
    expect(clean("SELECT a FROM t WHERE b = $123456789")).toBe(false);
    expect(clean("SELECT a FROM t WHERE b = $2 AND c = $1")).toBe(true);
    // Value: protects=the cloud stores no constant and no comment, each on its own; fails_when=the allowlist goes back to refusing only the token names it knows; why_new=bit and hex strings were refused only beside a string; seam=none
    for (const sql of [
      // The scanner gives bit and hex strings no name of their own.
      "SELECT email FROM t WHERE b = X'6a616e65'",
      "SELECT email FROM t WHERE b = B'1010'",
      "SELECT email FROM t WHERE b = $$jane$$",
      "SELECT email FROM t WHERE b = E'x'",
      "SELECT email FROM t WHERE b = 1.5",
      "SELECT email FROM t WHERE id = $1 /* jane@acme.com */",
      "-- 4111 1111 1111 1111\nSELECT email FROM t WHERE id = $1",
    ]) {
      expect(clean(sql), sql).toBe(false);
    }
  });

  it("holds for text cut to fit, which doesn't parse", () => {
    const clean = (sql: string) => !unredactedStatement(sql);
    expect(clean("INSERT INTO t (a, b) VALUES ($1, $2), ($3")).toBe(true);
    expect(clean("SELECT a FROM t WHERE b = 'jane")).toBe(false);
    expect(clean("SELECT a FROM t WHERE b = E'x")).toBe(false);
    // Value: protects=cut text holding an integer is never stored, position or value; fails_when=unparseable text is judged by the scan alone again; why_new=only cut strings were tested; seam=none
    expect(clean("SELECT a FROM t WHERE age = 42 AND b IN ($1")).toBe(false);
  });
});

describe("what the security review found", () => {
  const withheld = (sql: string) => {
    const out = redactStatement(sql, NAMES);
    return out.ok ? out.sql : `withheld: ${out.withheld}`;
  };

  it("redacts values inside type modifiers", () => {
    expect(withheld("SELECT NULL::text($$jane@acme.com$$)")).toBe(
      "SELECT CAST(NULL AS text($1))",
    );
    expect(withheld("SELECT NULL::mytype('x', 4111111111111111)")).toBe(
      "SELECT CAST(NULL AS mytype($1, $2))",
    );
    expect(withheld("SELECT 1::numeric(123456789, 2)")).toBe(
      "SELECT CAST($1 AS numeric($2, 2))",
    );
    // Real modifiers stay, an interval's fields included.
    expect(
      withheld(
        "SELECT name::varchar(255), total::numeric(10,2), created_at::interval day to second FROM orders",
      ),
    ).toBe(
      "SELECT CAST(name AS varchar(255)), CAST(total AS numeric(10, 2)), CAST(created_at AS interval day to second) FROM orders",
    );
  });

  it("never throws: forms the deparser can't print, and statements nested too deep", () => {
    expect(withheld("SELECT JSON_VALUE(name, '$.email') FROM customers")).toBe(
      "withheld: check",
    );
    expect(
      withheld(`SELECT ${Array.from({ length: 3000 }, () => "1").join(" + ")}`),
    ).toMatch(/^withheld: (check|long)$/);
    expect(redactStatement("x".repeat(MAX_REDACTED_INPUT + 1), NAMES)).toEqual({
      ok: false,
      withheld: "long",
      kinds: [],
    });
  });

  it("renumbers markers the agent wrote and redacts implausible positions", () => {
    expect(withheld("SELECT id FROM customers WHERE id = $123456789")).toBe(
      "SELECT id FROM customers WHERE id = $1",
    );
    expect(withheld("SELECT id FROM customers ORDER BY 123456789")).toBe(
      "SELECT id FROM customers ORDER BY $1",
    );
  });

  it("withholds text holding a quoted name the catalog doesn't have, wherever it sits", () => {
    for (const sql of [
      'SELECT id FROM customers WHERE "jane@acme.com"(id)',
      'SELECT CAST(id AS "4111-1111-1111-1111") FROM customers',
      'SELECT name COLLATE "jane@acme.com" FROM customers',
      'CREATE TABLE t (a int) WITH ("jane@acme.com" = 1)',
      "SELECT '{1}'::int[123456789]",
      "CREATE TABLE t (a int) WITH (fillfactor = 123456789)",
    ]) {
      expect(withheld(sql), sql).toBe("withheld: check");
    }
  });
});

/** The values a statement writes as literals, long enough to look for. */
function literalsOf(sql: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const node = v as Record<string, unknown>;
    const c = node.A_Const as
      | {
          sval?: { sval?: string };
          ival?: { ival?: number };
          fval?: { fval?: string };
        }
      | undefined;
    if (c?.sval?.sval && c.sval.sval.length >= 4) out.push(c.sval.sval);
    if (c?.ival?.ival !== undefined && Math.abs(c.ival.ival) >= 1000)
      out.push(String(c.ival.ival));
    if (c?.fval?.fval && c.fval.fval.length >= 4) out.push(c.fval.fval);
    for (const x of Object.values(node)) walk(x);
  };
  try {
    walk(parseSync(sql));
  } catch {
    // Doesn't parse: it has no text to look in.
  }
  return out;
}

describe("the whole corpus", () => {
  const cases = loadCorpus();

  it("leaves no literal and no value in any statement, and checks clean", () => {
    let redacted = 0;
    for (const c of cases) {
      const names = catalogNames(c.input.catalog);
      const out = redactStatement(c.input.sql, names);
      // Deterministic: the same input, the same text.
      expect(redactStatement(c.input.sql, names), c.id).toEqual(out);
      if (!out.ok) continue;
      redacted++;
      // No string constant survives: only parameters, names and keywords.
      expect(out.sql, c.id).not.toContain("'");
      expect(unredactedStatement(out.sql, names), c.id).toBe(false);
      for (const value of literalsOf(c.input.sql)) {
        if (names.has(value)) continue;
        expect(out.sql, `${c.id}: ${value}`).not.toContain(value);
      }
    }
    expect(redacted).toBeGreaterThan(1000);
  });

  it("withholds text only for kinds the core doesn't evaluate, unparseable input, quoted unknown names and one known form", () => {
    const checked: string[] = [];
    for (const c of cases) {
      const out = redactStatement(c.input.sql, catalogNames(c.input.catalog));
      if (out.ok) continue;
      if (out.withheld === "check") {
        checked.push(c.input.sql);
        continue;
      }
      // Withheld for its kind or for not parsing: the core denies it too.
      const e = evaluate(c.input);
      expect(e.verdict, c.id).toBe("deny");
    }
    expect(checked).toEqual([
      // Quoted names the catalog doesn't have (Postgres folds these
      // function names, but a quoted name is where a value would hide).
      `SELECT "PG_READ_FILE"('/etc/passwd')`,
      `SELECT "LOWER"(credit_card) FROM customers`,
      `SELECT "CURRENT_SETTING"('midplane.mask_salt')`,
      // SELECT INTO TEMP, which pgsql-deparser can't print.
      "SELECT id INTO TEMP tmp FROM users",
      "SELECT id INTO TEMP foo FROM users",
    ]);
  });
});
