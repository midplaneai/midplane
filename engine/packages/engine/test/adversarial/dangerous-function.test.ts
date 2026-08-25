// dangerous_function corpus.
//
// The rule refuses functions that read or write data outside the relations a
// statement names. Two families with very different privilege stories, both
// refused:
//   • XML export (query_to_xml / table_to_xml / schema_to_xml / database_to_xml)
//     — PostgreSQL CORE, EXECUTE granted to PUBLIC. Needs NO privileged role, so
//     these bypass table_access AND tenant_scope on an ordinary connection.
//     Verified against live PG 14.15: has_function_privilege(<plain role>,
//     'query_to_xml(...)', 'EXECUTE') = true.
//   • filesystem / large object (pg_read_file, lo_export, …) — Postgres itself
//     denies these to a role that is not superuser / pg_read_server_files.
//     Refused anyway, because Midplane's job is making a privileged connection
//     safe to point an agent at.
//
// The ALLOW cases matter as much as the DENY cases: this rule is always on and
// ungated, so a false positive breaks ordinary analytics for everyone.

import { describe, expect, test } from "bun:test";
import { parse } from "../../src/dialects/postgres/parse.ts";
import { evaluate } from "../../src/policy/index.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { tableAccess } from "../../src/policy/rules/table-access.ts";
import { tenantScope } from "../../src/policy/rules/tenant-scope.ts";
import { dangerousStatement } from "../../src/policy/rules/dangerous-statement.ts";
import { dangerousFunction } from "../../src/policy/rules/dangerous-function.ts";

// Deliberately PERMISSIVE on tables: `default: read_write` means table_access
// and tenant_scope have no reason to deny, so any DENY below is attributable to
// dangerous_function alone.
const permissiveRules = [
  parseError(),
  multiStatement(),
  tableAccess({ default: "read_write", tables: {} }),
  tenantScope(),
  dangerousStatement(),
  dangerousFunction(),
];

const ctx = { tenant_id: "42" };

async function decide(sql: string) {
  return evaluate({ parse: await parse(sql), ctx, rules: permissiveRules });
}

async function expectDeny(sql: string) {
  const r = await decide(sql);
  expect(r.verdict.decision).toBe("DENY");
  expect(r.verdict.reason).toBe("dangerous_function");
  return r;
}

async function expectAllow(sql: string) {
  const r = await decide(sql);
  expect(r.verdict.decision).toBe("ALLOW");
  return r;
}

describe("dangerous_function — dynamic SQL / relation dump (no privileges needed)", () => {
  test.each([
    ["query_to_xml runs a SQL string", `SELECT query_to_xml('SELECT ssn FROM secrets', false, true, '')`],
    ["query_to_xmlschema", `SELECT query_to_xmlschema('SELECT 1', false, true, '')`],
    ["query_to_xml_and_xmlschema", `SELECT query_to_xml_and_xmlschema('SELECT 1', false, true, '')`],
    ["table_to_xml dumps a named relation", `SELECT table_to_xml('secrets'::regclass, false, true, '')`],
    ["schema_to_xml dumps a schema", `SELECT schema_to_xml('public', false, true, '')`],
    ["database_to_xml dumps everything", `SELECT database_to_xml(false, true, '')`],
    ["cursor_to_xml", `SELECT cursor_to_xml('c'::refcursor, 100, false, true, '')`],
    ["dblink reads another server", `SELECT * FROM dblink('host=x', 'SELECT 1') AS t(a int)`],
    ["dblink_connect", `SELECT dblink_connect('host=evil.example.com')`],
  ])("denies %s", async (_label, sql) => {
    await expectDeny(sql);
  });

  test("the deny message names the bypass, not a config key", async () => {
    const r = await expectDeny(
      `SELECT query_to_xml('SELECT ssn FROM secrets', false, true, '')`,
    );
    expect(r.verdict.message).toContain("query_to_xml");
    expect(r.verdict.message).toContain("bypasses table-access");
    // The reader is an agent that cannot edit policy — no key to flip.
    expect(r.verdict.message).not.toContain("guardrails.");
  });
});

describe("dangerous_function — filesystem / large object / admin", () => {
  test.each([
    ["pg_read_file", `SELECT pg_read_file('/etc/passwd')`],
    ["pg_read_binary_file", `SELECT pg_read_binary_file('/etc/passwd')`],
    ["pg_stat_file", `SELECT pg_stat_file('/etc/passwd')`],
    ["pg_ls_dir in the target list", `SELECT pg_ls_dir('/')`],
    ["pg_ls_dir in FROM position", `SELECT * FROM pg_ls_dir('/')`],
    ["lo_export writes a file", `SELECT lo_export(lo_import('/etc/passwd'), '/tmp/x')`],
    ["lo_put", `SELECT lo_put(1234, 0, '\\xdeadbeef'::bytea)`],
    ["current_setting can reach the mask salt", `SELECT current_setting('midplane.mask_salt')`],
    ["set_config", `SELECT set_config('search_path', 'evil', false)`],
    ["json_populate_record derefs a rowtype", `SELECT json_populate_record(null::secrets, '{}')`],
    ["jsonb_populate_recordset derefs a rowtype", `SELECT jsonb_populate_recordset(null::secrets, '[]')`],
    ["pg_terminate_backend", `SELECT pg_terminate_backend(1234)`],
    ["pg_reload_conf", `SELECT pg_reload_conf()`],
  ])("denies %s", async (_label, sql) => {
    await expectDeny(sql);
  });
});

describe("dangerous_function — sequence writes", () => {
  // A write executed through a statement every other rule reads as a SELECT.
  // Reachable in practice: an app role granted `ALL ON ALL SEQUENCES IN SCHEMA
  // public` (a common setup-script grant) can call setval — verified against a
  // live unprivileged role. Winding a sequence backwards makes every later
  // INSERT collide on the primary key.
  test("denies setval", async () => {
    await expectDeny(`SELECT setval('users_id_seq', 1)`);
  });

  test("denies setval nested in an allowed-looking read", async () => {
    await expectDeny(`SELECT id FROM orders WHERE id = setval('users_id_seq', 1)`);
  });

  test("the message explains the consequence, not just the name", async () => {
    const r = await expectDeny(`SELECT setval('users_id_seq', 1)`);
    expect(r.verdict.message).toContain("setval");
    expect(r.verdict.message).toContain("primary-key collisions");
  });

  // nextval/currval/lastval are a DELIBERATE non-denial, pinned so the
  // asymmetry is a considered line rather than something a later edit
  // "completes" by accident. nextval is part of a normal write idiom
  // (`INSERT INTO t (id) VALUES (nextval(...))`) already governed by
  // table_access / block_dml; its standalone reach is burning sequence values,
  // and sequence gaps are ordinary Postgres behavior.
  test.each([
    ["nextval", `SELECT nextval('users_id_seq')`],
    ["nextval inside a legitimate INSERT", `INSERT INTO t (id, v) VALUES (nextval('t_id_seq'), 'x')`],
    ["currval", `SELECT currval('users_id_seq')`],
    ["lastval", `SELECT lastval()`],
  ])("allows %s (deliberate)", async (_label, sql) => {
    await expectAllow(sql);
  });
});

describe("dangerous_function — evasion", () => {
  test("schema qualification does not evade (pg_catalog.)", async () => {
    await expectDeny(`SELECT pg_catalog.pg_read_file('/etc/passwd')`);
    await expectDeny(`SELECT pg_catalog.query_to_xml('SELECT 1', false, true, '')`);
  });

  test("a user-schema function of the same name is also refused", async () => {
    // Over-refusing a name chosen to collide with a dangerous builtin is the
    // safe direction: we cannot tell from the AST which one resolves.
    await expectDeny(`SELECT public.pg_read_file('/etc/passwd')`);
  });

  test("case does not evade", async () => {
    await expectDeny(`SELECT PG_READ_FILE('/etc/passwd')`);
    await expectDeny(`SELECT Query_To_Xml('SELECT 1', false, true, '')`);
  });

  test("nesting does not evade (GHSA-468r-mhwc-vxjc shape)", async () => {
    // pg_anon's allowlist fell to exactly this: a benign outer call wrapping an
    // untrusted inner one. The inventory walk is fully recursive.
    await expectDeny(`SELECT upper(pg_read_file('/etc/passwd'))`);
    await expectDeny(`SELECT length(convert_from(pg_read_binary_file('/etc/passwd'), 'UTF8'))`);
    await expectDeny(`SELECT pg_catalog.upper(public.pg_read_file('/etc/passwd')::text)`);
  });

  test("hiding the call in a CTE, subquery, or WHERE clause does not evade", async () => {
    await expectDeny(`WITH x AS (SELECT pg_read_file('/etc/passwd') AS f) SELECT * FROM x`);
    await expectDeny(`SELECT (SELECT pg_read_file('/etc/passwd'))`);
    await expectDeny(`SELECT id FROM orders WHERE note = pg_read_file('/etc/passwd')`);
    await expectDeny(`SELECT id FROM orders ORDER BY pg_read_file('/etc/passwd')`);
  });

  test("hiding the call inside a write statement does not evade", async () => {
    await expectDeny(`INSERT INTO exfil (data) VALUES (pg_read_file('/etc/passwd'))`);
    await expectDeny(`UPDATE t SET c = pg_read_file('/etc/passwd') WHERE id = 1`);
  });
});

describe("dangerous_function — closes the reported bypasses", () => {
  // The regression this rule exists for: under `default: deny` these were ALLOW
  // while the plainly-spelled equivalent read was DENY.
  const denyAllRules = [
    parseError(),
    multiStatement(),
    tableAccess({ default: "deny", tables: {} }),
    tenantScope(),
    dangerousStatement({ blockDml: true, blockUnqualifiedDml: true, blockDdl: true }),
    dangerousFunction(),
  ];

  test.each([
    `SELECT query_to_xml('SELECT ssn, api_key FROM secrets', false, true, '')`,
    `SELECT table_to_xml('secrets'::regclass, false, true, '')`,
    `SELECT database_to_xml(false, true, '')`,
    `SELECT pg_read_file('/etc/passwd')`,
    `SELECT lo_export(lo_import('/etc/passwd'), '/tmp/x')`,
  ])("denies %s under default:deny", async (sql) => {
    const r = evaluate({ parse: await parse(sql), ctx, rules: denyAllRules });
    expect(r.verdict.decision).toBe("DENY");
  });

  test("tenant isolation holds against the function-argument form", async () => {
    // tenant_scope is correctly configured and demonstrably working, but sees an
    // empty scope for the XML form — dangerous_function is what stops it.
    const tenantRules = [
      parseError(),
      multiStatement(),
      tableAccess({ default: "read", tables: { users: "read" } }),
      tenantScope({ defaultColumn: null, overrides: { users: "org_id" }, exempt: [] }),
      dangerousStatement(),
      dangerousFunction(),
    ];
    const run = async (sql: string) =>
      evaluate({ parse: await parse(sql), ctx, rules: tenantRules }).verdict;

    // Baseline: tenant_scope is live and doing its job.
    expect((await run(`SELECT * FROM users`)).reason).toBe("tenant_scope_missing");
    expect((await run(`SELECT * FROM users WHERE org_id = '42'`)).decision).toBe("ALLOW");
    expect((await run(`SELECT * FROM users WHERE org_id = '99'`)).reason).toBe(
      "tenant_scope_missing",
    );

    // The cross-tenant read spelled as a function argument.
    expect((await run(`SELECT query_to_xml('SELECT * FROM users', false, true, '')`)).reason)
      .toBe("dangerous_function");
    expect((await run(`SELECT table_to_xml('users'::regclass, false, true, '')`)).reason)
      .toBe("dangerous_function");
  });
});

describe("dangerous_function — does not over-refuse ordinary queries", () => {
  // This rule is always on and ungated, so a false positive here is an outage.
  test.each([
    ["plain select", `SELECT id, email FROM users WHERE org_id = '42'`],
    ["aggregates", `SELECT count(*), sum(total), avg(total), max(created_at) FROM orders`],
    ["string functions", `SELECT upper(name), substr(email, 1, 5), concat(a, b) FROM users`],
    ["date functions", `SELECT date_trunc('day', created_at), now(), age(created_at) FROM orders`],
    ["json construction", `SELECT json_build_object('id', id, 'email', email) FROM users`],
    ["window functions", `SELECT row_number() OVER (ORDER BY id), rank() OVER () FROM orders`],
    ["a user-defined function", `SELECT my_business_helper(total) FROM orders`],
    ["a schema-qualified user function", `SELECT analytics.compute_ltv(id) FROM users`],
    ["set-returning builtins", `SELECT generate_series(1, 10)`],
    ["unnest", `SELECT unnest(tags) FROM posts`],
    ["coalesce and casts", `SELECT coalesce(a, b)::text FROM t`],
    ["a CTE with joins", `WITH r AS (SELECT * FROM orders) SELECT count(*) FROM r JOIN users USING (id)`],
    // Named similarly to denied entries but genuinely different functions.
    ["to_json is not denied here", `SELECT to_json(a) FROM t`],
    ["pg_typeof is introspection, not data reach", `SELECT pg_typeof(id) FROM users`],
    // The *_to_record* family takes ONLY json — the output shape comes from the
    // caller's explicit AS column-definition list, not from a table, so it
    // dereferences nothing. Its rowtype-taking sibling json_populate_record IS
    // denied above; these must not be swept in with it.
    ["json_to_record", `SELECT * FROM json_to_record('{"a":1}') AS r(a int, b text)`],
    ["jsonb_to_record", `SELECT * FROM jsonb_to_record('{"a":1}') AS r(a int)`],
    ["json_to_recordset", `SELECT * FROM json_to_recordset('[{"a":1}]') AS r(a int)`],
    ["jsonb_to_recordset", `SELECT * FROM jsonb_to_recordset('[{"a":1}]') AS r(a int)`],
  ])("allows %s", async (_label, sql) => {
    await expectAllow(sql);
  });
});

describe("dangerous_function — IR", () => {
  test("functionsInvoked records nested calls in walk order", async () => {
    const p = await parse(`SELECT upper(pg_read_file('/etc/passwd'))`);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const { postgresDialect } = await import("../../src/dialects/postgres/index.ts");
    const program = postgresDialect.normalize(p.ast);
    expect(program.functionsInvoked.map((f) => f.name)).toEqual([
      "upper",
      "pg_read_file",
    ]);
  });

  test("qualification is preserved in the IR even though matching ignores it", async () => {
    const p = await parse(`SELECT pg_catalog.pg_read_file('/x')`);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const { postgresDialect } = await import("../../src/dialects/postgres/index.ts");
    const program = postgresDialect.normalize(p.ast);
    expect(program.functionsInvoked).toEqual([
      { schema: "pg_catalog", name: "pg_read_file" },
    ]);
  });

  test("a statement with no calls records none", async () => {
    const p = await parse(`SELECT id FROM users`);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const { postgresDialect } = await import("../../src/dialects/postgres/index.ts");
    const program = postgresDialect.normalize(p.ast);
    expect(program.functionsInvoked).toEqual([]);
  });
});
