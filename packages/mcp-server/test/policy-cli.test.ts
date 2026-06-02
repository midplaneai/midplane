// policy-cli — exercises `midplane policy {init,validate,lint,test}`.
//
// Two strategies, mirroring audit-cli.test.ts:
//   • subprocess (`bun src/cli.ts policy ...`) for the end-to-end contract —
//     stdout/stderr text and exit codes, which are the user-facing surface.
//   • direct import for the two things a subprocess can't cover cheaply:
//       - scaffold() output validity WITHOUT a live Postgres (the `init --url`
//         introspection is decoupled into scaffold(table_list)).
//       - verdict PARITY: the same (sql, ctx) run through the engine's
//         evaluate() must match what `policy test` prints.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import {
  evaluate,
  parseError,
  multiStatement,
  tableAccess,
  tenantScope,
  postgresDialect,
  type Rule,
  type EngineContext,
} from "@midplane/engine";
import { scaffold } from "../src/policy-cli.ts";
import { PolicyFileSchema, parsePolicyYaml } from "../src/config.ts";

const CLI_PATH = join(import.meta.dir, "..", "src", "cli.ts");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "midplane-policy-cli-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeFile(name: string, content: string): string {
  const p = join(tmp, name);
  writeFileSync(p, content, "utf8");
  return p;
}

async function runCli(
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", CLI_PATH, ...args], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = opts.timeoutMs ?? 15000;
  const timer = setTimeout(() => proc.kill(), timeout);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, exitCode };
}

// ── scaffold() — init's YAML generation, DB-free ─────────────────────────────

describe("scaffold()", () => {
  test("introspected tables + tenant column produces a schema-valid file", () => {
    const text = scaffold({
      tables: ["users", "orders", "audit_log"],
      tenantColumn: "tenant_id",
      introspected: true,
    });
    const doc = yaml.load(text);
    const parsed = PolicyFileSchema.safeParse(doc);
    expect(parsed.success).toBe(true);

    const data = parsed.data as any;
    expect(data.table_access.default).toBe("read");
    // Every introspected table listed, schema-qualified, defaulting to read.
    expect(data.table_access.tables["public.users"]).toBe("read");
    expect(data.table_access.tables["public.orders"]).toBe("read");
    expect(data.table_access.tables["public.audit_log"]).toBe("read");
    // tenant_scope block on the requested column, audit_log exempt.
    expect(data.tenant_scope.enabled).toBe(true);
    expect(data.tenant_scope.column).toBe("tenant_id");
    expect(data.tenant_scope.exempt).toContain("audit_log");
    // The flip-to-read_write hint is present for the author.
    expect(text).toContain("read_write");
  });

  test("introspected, no tenant column → valid, no tenant_scope block", () => {
    const text = scaffold({ tables: ["users"], tenantColumn: undefined, introspected: true });
    const doc = yaml.load(text) as any;
    expect(PolicyFileSchema.safeParse(doc).success).toBe(true);
    expect(doc.tenant_scope).toBeUndefined();
  });

  test("static starter (no --url) is schema-valid", () => {
    const text = scaffold({ tables: null, tenantColumn: undefined, introspected: false });
    const doc = yaml.load(text);
    expect(PolicyFileSchema.safeParse(doc).success).toBe(true);
  });

  test("static starter + tenant column is schema-valid", () => {
    const text = scaffold({ tables: null, tenantColumn: "tenant_id", introspected: false });
    const doc = yaml.load(text) as any;
    expect(PolicyFileSchema.safeParse(doc).success).toBe(true);
    expect(doc.tenant_scope.column).toBe("tenant_id");
  });

  test("connected DB with zero public tables → valid (tables: {})", () => {
    const text = scaffold({ tables: [], tenantColumn: undefined, introspected: true });
    const doc = yaml.load(text) as any;
    expect(PolicyFileSchema.safeParse(doc).success).toBe(true);
    expect(doc.table_access.tables).toEqual({});
  });

  test("never embeds a DSN", () => {
    const text = scaffold({ tables: ["users"], tenantColumn: "tenant_id", introspected: true });
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("@");
  });

  test("table names with YAML-sensitive characters stay parseable", () => {
    // Quoted Postgres identifiers can contain anything. The scaffold must
    // serialize keys, not splice raw text, or `init --url` emits a file that
    // won't parse/validate.
    const text = scaffold({
      tables: ["weird: name", "1starts_digit", "has space", "#hash"],
      tenantColumn: "tenant_id",
      introspected: true,
    });
    const doc = yaml.load(text) as any;
    expect(PolicyFileSchema.safeParse(doc).success).toBe(true);
    // Keys round-trip to their schema-qualified form.
    expect(doc.table_access.tables["public.weird: name"]).toBe("read");
    expect(doc.table_access.tables["public.1starts_digit"]).toBe("read");
    expect(doc.table_access.tables["public.has space"]).toBe("read");
    expect(doc.table_access.tables["public.#hash"]).toBe("read");
  });
});

// ── init (subprocess) ────────────────────────────────────────────────────────

describe("midplane policy init", () => {
  test("static -o writes a file that validate passes", async () => {
    const out = join(tmp, "policy.yaml");
    const r = await runCli(["policy", "init", "-o", out]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);

    const v = await runCli(["policy", "validate", out]);
    expect(v.exitCode).toBe(0);
    expect(v.stdout.trim()).toBe("OK");
  });

  test("--tenant-column scaffolds a strict tenant_scope block", async () => {
    const out = join(tmp, "policy.yaml");
    const r = await runCli(["policy", "init", "--tenant-column", "org_id", "-o", out]);
    expect(r.exitCode).toBe(0);
    const doc = yaml.load(readFileSync(out, "utf8")) as any;
    expect(doc.tenant_scope.enabled).toBe(true);
    expect(doc.tenant_scope.column).toBe("org_id");
    expect(doc.tenant_scope.exempt).toContain("audit_log");

    const v = await runCli(["policy", "validate", out]);
    expect(v.exitCode).toBe(0);
  });

  test("refuses to overwrite an existing file", async () => {
    const out = writeFile("policy.yaml", "table_access: { default: read }\n");
    const r = await runCli(["policy", "init", "-o", out]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/refusing to overwrite/i);
    // The original content is untouched.
    expect(readFileSync(out, "utf8")).toBe("table_access: { default: read }\n");
  });

  test("without -o prints the scaffold to stdout", async () => {
    const r = await runCli(["policy", "init"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("table_access:");
    expect(r.stdout).toContain("default: read");
  });
});

// ── validate (subprocess) ────────────────────────────────────────────────────

describe("midplane policy validate", () => {
  test("valid file → OK, exit 0", async () => {
    const f = writeFile(
      "ok.yaml",
      "table_access:\n  default: read\n  tables:\n    public.users: read_write\n",
    );
    const r = await runCli(["policy", "validate", f]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("OK");
  });

  test("empty file is valid (inert policy)", async () => {
    const f = writeFile("empty.yaml", "");
    const r = await runCli(["policy", "validate", f]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("OK");
  });

  test("schema-invalid → INVALID with zod path + message, exit 1", async () => {
    const f = writeFile("bad.yaml", "table_access:\n  default: sideways\n");
    const r = await runCli(["policy", "validate", f]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("INVALID");
    // Path is surfaced.
    expect(r.stderr).toMatch(/table_access\.default/);
  });

  test("malformed YAML → exit 1", async () => {
    const f = writeFile("bad.yaml", "table_access: : :\n  - nope\n");
    const r = await runCli(["policy", "validate", f]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/not valid YAML/i);
  });

  test("semantic error (mappings + overrides) → INVALID, exit 1", async () => {
    const f = writeFile(
      "conflict.yaml",
      "tenant_scope:\n  column: tenant_id\n  mappings: { orders: tenant_id }\n  overrides: { users: tenant_id }\n",
    );
    const r = await runCli(["policy", "validate", f]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/mappings.*overrides|overrides.*mappings/i);
  });

  test("semantic error (duplicate databases[].name) → INVALID, exit 1", async () => {
    const f = writeFile(
      "dup.yaml",
      "databases:\n" +
        "  - name: prod\n    url: ${A}\n    table_access: { default: read }\n" +
        "  - name: prod\n    url: ${B}\n    table_access: { default: read }\n",
    );
    const r = await runCli(["policy", "validate", f]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch(/duplicate database name/i);
  });

  test("unset ${VAR} in databases url does not fail an offline validate", async () => {
    const f = writeFile(
      "multi.yaml",
      "databases:\n  - name: prod\n    url: ${UNSET_DSN_VAR}\n    table_access: { default: read }\n",
    );
    const r = await runCli(["policy", "validate", f]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("OK");
  });

  test("missing file → exit 1", async () => {
    const r = await runCli(["policy", "validate", join(tmp, "nope.yaml")]);
    expect(r.exitCode).toBe(1);
  });

  test("no file arg → usage, exit 2", async () => {
    const r = await runCli(["policy", "validate"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/usage/i);
  });
});

// ── lint (subprocess) ────────────────────────────────────────────────────────

describe("midplane policy lint", () => {
  test("default: read_write → [ERROR], exit 1", async () => {
    const f = writeFile("rw.yaml", "table_access:\n  default: read_write\n");
    const r = await runCli(["policy", "lint", f]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/\[ERROR\].*read_write/);
  });

  test("read_write grants are listed as [INFO], exit 0", async () => {
    const f = writeFile(
      "grants.yaml",
      "table_access:\n  default: read\n  tables:\n    public.flags: read_write\n    public.users: read\ntenant_scope:\n  enabled: true\n  column: tenant_id\n  exempt: [audit_log]\n",
    );
    const r = await runCli(["policy", "lint", f]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/\[INFO\].*public\.flags/);
  });

  test("disabled tenant_scope → [WARN], exit 0", async () => {
    const f = writeFile(
      "noscope.yaml",
      "table_access:\n  default: read\n  tables: { public.users: read }\ntenant_scope:\n  enabled: false\n  column: tenant_id\n",
    );
    const r = await runCli(["policy", "lint", f]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/\[WARN\].*enabled: false/);
  });

  test("audit table not exempt under strict scope → [WARN], exit 0", async () => {
    const f = writeFile(
      "auditscope.yaml",
      "table_access:\n  default: read\n  tables: { public.audit_log: read }\ntenant_scope:\n  enabled: true\n  column: tenant_id\n",
    );
    const r = await runCli(["policy", "lint", f]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/\[WARN\].*audit_log.*exempt/);
  });

  test("clean tenant-scoped policy → no findings, exit 0", async () => {
    const f = writeFile(
      "clean.yaml",
      "table_access:\n  default: read\n  tables: { public.users: read }\ntenant_scope:\n  enabled: true\n  column: tenant_id\n  exempt: [audit_log]\n",
    );
    const r = await runCli(["policy", "lint", f]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/no findings/i);
  });

  test("per-database labelling for the multi-DB shape", async () => {
    const f = writeFile(
      "multi.yaml",
      "databases:\n  - name: analytics\n    url: ${X}\n    table_access: { default: read_write }\n",
    );
    const r = await runCli(["policy", "lint", f]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/databases\.analytics.*read_write/);
  });

  test("not schema-valid → exit 2, tells you to validate first", async () => {
    const f = writeFile("bad.yaml", "table_access:\n  default: nope\n");
    const r = await runCli(["policy", "lint", f]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/validate/);
  });

  test("schema-valid but semantically-invalid (duplicate db names) is gated, not green-lit", async () => {
    // Passes the zod schema but fails the loader's semantic checks. lint must
    // NOT print "no findings" / exit 0 — it would weaken the CI gate.
    const f = writeFile(
      "dup.yaml",
      "databases:\n" +
        "  - name: prod\n    url: ${A}\n    table_access: { default: read }\n" +
        "  - name: prod\n    url: ${B}\n    table_access: { default: read }\n",
    );
    const r = await runCli(["policy", "lint", f]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/validate/);
    expect(r.stdout).not.toMatch(/no findings/i);
  });
});

// ── test (subprocess) ────────────────────────────────────────────────────────

const STRICT_POLICY =
  "table_access:\n" +
  "  default: read\n" +
  "  tables:\n" +
  "    public.flags: read_write\n" +
  "tenant_scope:\n" +
  "  enabled: true\n" +
  "  column: tenant_id\n" +
  "  exempt: [audit_log]\n";

describe("midplane policy test", () => {
  test("write to a read-only table → DENY table_access, exit 1", async () => {
    const f = writeFile("p.yaml", STRICT_POLICY);
    const r = await runCli(["policy", "test", f, "--sql", "DELETE FROM users WHERE tenant_id='a'"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("DENY");
    expect(r.stdout).toMatch(/rule:\s+table_access/);
  });

  test("missing tenant predicate → DENY tenant_scope_missing, exit 1", async () => {
    const f = writeFile("p.yaml", STRICT_POLICY);
    const r = await runCli(["policy", "test", f, "--sql", "SELECT * FROM flags", "--tenant-id", "a"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/rule:\s+tenant_scope_missing/);
  });

  test("a query that satisfies policy → ALLOW, exit 0", async () => {
    const f = writeFile("p.yaml", STRICT_POLICY);
    const r = await runCli([
      "policy", "test", f,
      "--sql", "UPDATE flags SET enabled=true WHERE tenant_id='a'",
      "--tenant-id", "a",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("ALLOW");
    expect(r.stdout).toMatch(/statement:\s+UPDATE/);
  });

  test("multi-statement → DENY multi_statement, exit 1", async () => {
    const f = writeFile("p.yaml", STRICT_POLICY);
    const r = await runCli(["policy", "test", f, "--sql", "SELECT 1; DROP TABLE flags"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/rule:\s+multi_statement/);
  });

  test("unparseable SQL → DENY parse_error, exit 1", async () => {
    const f = writeFile("p.yaml", STRICT_POLICY);
    const r = await runCli(["policy", "test", f, "--sql", "SELECT FROM WHERE"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/rule:\s+parse_error/);
  });

  test("--json emits a machine-readable verdict", async () => {
    const f = writeFile("p.yaml", STRICT_POLICY);
    const r = await runCli(["policy", "test", f, "--sql", "DELETE FROM users WHERE tenant_id='a'", "--json"]);
    expect(r.exitCode).toBe(1);
    const j = JSON.parse(r.stdout);
    expect(j.decision).toBe("DENY");
    expect(j.reason).toBe("table_access");
    expect(typeof j.message).toBe("string");
    expect(j.tenant_id).toBe("__self_host__");
  });

  test("--db selects the named database in a multi-DB file", async () => {
    const f = writeFile(
      "multi.yaml",
      "databases:\n" +
        "  - name: prod\n    url: ${X}\n    table_access: { default: read }\n" +
        "  - name: analytics\n    url: ${Y}\n    table_access: { default: read_write }\n",
    );
    // analytics is read_write → the same write that prod denies is allowed.
    const a = await runCli(["policy", "test", f, "--db", "analytics", "--sql", "DELETE FROM t", "--json"]);
    expect(a.exitCode).toBe(0);
    expect(JSON.parse(a.stdout).decision).toBe("ALLOW");

    const p = await runCli(["policy", "test", f, "--db", "prod", "--sql", "DELETE FROM t", "--json"]);
    expect(p.exitCode).toBe(1);
    expect(JSON.parse(p.stdout).decision).toBe("DENY");
  });

  test("unknown --db → exit 2, lists available", async () => {
    const f = writeFile(
      "multi.yaml",
      "databases:\n  - name: prod\n    url: ${X}\n    table_access: { default: read }\n",
    );
    const r = await runCli(["policy", "test", f, "--db", "nope", "--sql", "SELECT 1"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/no database named "nope"/);
  });

  test("missing --sql → usage, exit 2", async () => {
    const f = writeFile("p.yaml", STRICT_POLICY);
    const r = await runCli(["policy", "test", f]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/--sql/);
  });
});

// ── verdict parity: `policy test` === engine.evaluate() ──────────────────────

describe("policy test verdict parity with the engine", () => {
  // Rebuild the engine's per-DB rule wiring from the policy file, exactly as
  // engine-factory.ts does, then compare evaluate()'s verdict to what the CLI
  // prints over a subprocess. If the CLI's wiring ever drifts (wrong rule
  // order, dropped rule, mis-mapped config), these diverge.
  function rulesForFile(file: string): Rule[] {
    const policy = parsePolicyYaml(readFileSync(file, "utf8"), `file ${file}`);
    const spec = policy.databases[0]!;
    return [
      parseError(),
      multiStatement(),
      tableAccess(spec.tableAccess ?? undefined),
      tenantScope(spec.tenantScope),
    ];
  }

  async function engineVerdict(file: string, sql: string, tenantId: string) {
    const ctx: EngineContext = {
      tenant_id: tenantId,
      agent_name: null,
      agent_version: null,
      mcp_token_id: null,
      role: "agent_readonly",
    };
    const parse = await postgresDialect.parse(sql);
    const result = evaluate({ parse, ctx, rules: rulesForFile(file), dialect: postgresDialect });
    const allowed = result.verdict.decision === "ALLOW";
    return {
      decision: result.verdict.decision,
      reason: allowed ? null : (result.verdict as { reason: string }).reason,
      message: allowed ? null : (result.verdict as { message?: string }).message ?? null,
    };
  }

  const CASES: Array<{ sql: string; tenant: string }> = [
    { sql: "DELETE FROM users WHERE tenant_id='a'", tenant: "a" },
    { sql: "SELECT * FROM flags", tenant: "a" },
    { sql: "UPDATE flags SET enabled=true WHERE tenant_id='a'", tenant: "a" },
    { sql: "SELECT 1; DROP TABLE flags", tenant: "a" },
    { sql: "SELECT FROM WHERE", tenant: "a" },
    { sql: "SELECT * FROM flags WHERE tenant_id='b'", tenant: "a" },
  ];

  test("CLI --json matches evaluate() for every case", async () => {
    const f = writeFile("p.yaml", STRICT_POLICY);
    for (const c of CASES) {
      const expected = await engineVerdict(f, c.sql, c.tenant);
      const r = await runCli(["policy", "test", f, "--sql", c.sql, "--tenant-id", c.tenant, "--json"]);
      const got = JSON.parse(r.stdout);
      expect({ decision: got.decision, reason: got.reason, message: got.message }).toEqual(expected);
      // Exit code tracks the decision.
      expect(r.exitCode).toBe(expected.decision === "ALLOW" ? 0 : 1);
    }
  }, 30000);
});
