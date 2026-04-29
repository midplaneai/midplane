// Adversarial corpus — parse_error edges.
//
// V1: parser owns size limits, empty-input rejection, and surfaces
// SqlError as a clean DENY (not an exception). The Postgres-specific
// surface area is libpg-query 16.7.x — RETURNING, ON CONFLICT,
// JSON/JSONB ops, range types, unicode identifiers all parse cleanly.

import { describe, expect, test } from "bun:test";
import { makeEngine, baseCtx, tenantScopedCtx } from "../_helpers.ts";
import { PolicyRule } from "../../src/audit/types.ts";
import { expectDeny, expectAllow } from "./_helpers.ts";

const PARSE = PolicyRule.PARSE_ERROR;
const WRITES = PolicyRule.WRITES_REQUIRE_APPROVAL;

describe("adversarial/parse-edges: empty / whitespace", () => {
  test("empty string → parse_error", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "", PARSE);
  });

  test("whitespace only → parse_error", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "   \n\t  ", PARSE);
  });

  test("comment-only input → parse_error", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "-- nothing here", PARSE);
  });

  test("block-comment-only input → parse_error", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "/* nothing */", PARSE);
  });

  test("totally invalid SQL → parse_error", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "this is not sql", PARSE);
  });

  test("unterminated string literal → parse_error", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "SELECT 'unterminated", PARSE);
  });

  test("dangling FROM with no relation → parse_error", async () => {
    const { engine } = makeEngine();
    await expectDeny(engine, baseCtx, "SELECT * FROM", PARSE);
  });
});

describe("adversarial/parse-edges: size cap (1 MiB)", () => {
  test("just under 1 MiB → parses (allow on benign SELECT)", async () => {
    const { engine } = makeEngine();
    // SELECT 1 + line comment to pad. The comment doesn't count as a
    // statement, so the parser sees a single SELECT 1.
    const padding = "x".repeat(1_048_576 - 32);
    const sql = `SELECT 1 -- ${padding}`;
    expect(sql.length).toBeLessThanOrEqual(1_048_576);
    await expectAllow(engine, baseCtx, sql);
  });

  test("just over 1 MiB → parse_error before parsing", async () => {
    const { engine } = makeEngine();
    const sql = "SELECT 1 -- " + "x".repeat(1_048_700);
    await expectDeny(engine, baseCtx, sql, PARSE);
  });

  test("100 KiB benign SELECT → allow", async () => {
    const { engine } = makeEngine();
    const sql = "SELECT 1 -- " + "y".repeat(100_000);
    await expectAllow(engine, baseCtx, sql);
  });
});

describe("adversarial/parse-edges: Postgres-specific syntax", () => {
  test("INSERT … RETURNING → parses (writes denies)", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO logs (msg) VALUES ('x') RETURNING id",
      WRITES,
    );
  });

  test("UPDATE … RETURNING → parses (writes denies)", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "UPDATE logs SET msg='y' WHERE id=1 RETURNING id, msg",
      WRITES,
    );
  });

  test("ON CONFLICT DO NOTHING → parses (writes denies)", async () => {
    const { engine } = makeEngine();
    await expectDeny(
      engine,
      baseCtx,
      "INSERT INTO t (x) VALUES (1) ON CONFLICT (x) DO NOTHING",
      WRITES,
    );
  });

  test("JSON arrow operator (->) → parses + allow on read-only", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "SELECT data->'x' AS v FROM events WHERE id = 1",
    );
  });

  test("JSON arrow-text operator (->>) → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT data->>'name' FROM events");
  });

  test("JSONB containment (@>) → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "SELECT * FROM events WHERE meta @> '{\"k\":1}'::jsonb",
    );
  });

  test("range constructor int4range(1,10) → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT int4range(1, 10)");
  });

  test("range overlap operator (&&) → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "SELECT * FROM bookings WHERE during && tsrange('2026-01-01', '2026-01-31')",
    );
  });

  test("array literal → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT ARRAY[1, 2, 3]");
  });

  test("DISTINCT ON → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "SELECT DISTINCT ON (org_id) id, org_id FROM users ORDER BY org_id, id",
    );
  });

  test("window function → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "SELECT id, row_number() OVER (PARTITION BY org_id ORDER BY id) FROM users",
    );
  });

  test("FILTER aggregate → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "SELECT count(*) FILTER (WHERE id > 0) FROM users",
    );
  });

  test("LATERAL keyword → parses + allow on read-only", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      baseCtx,
      "SELECT * FROM users u, LATERAL (SELECT 1) AS s",
    );
  });
});

describe("adversarial/parse-edges: identifier corner cases", () => {
  test("quoted identifier with space → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT * FROM \"my table\"");
  });

  test("unicode identifier → parses + allow on read-only", async () => {
    // The unicode table name is not in the tenant_scope mapping in
    // baseCtx, so tenant_scope doesn't fire.
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, 'SELECT * FROM "üsers" WHERE "id" = 1');
  });

  test("schema-qualified identifier → parses + allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(engine, baseCtx, "SELECT * FROM public.users WHERE id = 1");
  });
});

describe("adversarial/parse-edges: tenant_scope with PG syntax", () => {
  test("scoped + JSON arrow → allow", async () => {
    const { engine } = makeEngine();
    await expectAllow(
      engine,
      tenantScopedCtx,
      "SELECT data->'x' FROM users WHERE org_id = 42",
    );
  });
});
