// `midplane policy` — author, trust, and dry-run a MIDPLANE_POLICY_FILE
// without hand-editing YAML blind.
//
// Four subcommands:
//   init      — scaffold a commented policy file (optionally introspected from
//               a live DB) so step one isn't "guess the YAML shape"
//   validate  — parse + check against the SAME zod schema the server boots
//               with (config.ts PolicyFileSchema). OK or precise errors.
//   lint      — security-posture findings the schema can't see: read_write
//               defaults, ungated tables, missing tenant_scope, audit tables
//               left scoped. Errors gate CI; warnings don't.
//   test      — run a query through the engine's real evaluate() against the
//               file's policy. No DB connection — pure policy eval. Answers
//               "would this pass, and what denial would the agent read?"
//
// No DSN is ever printed or written into a scaffold. `init --url` connects to
// read information_schema and then drops the connection; the DSN stays in the
// caller's env. argv is parsed the same hand-rolled way as audit-cli.ts (no
// commander/yargs); js-yaml + zod + the engine are reused, never reimplemented.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import {
  evaluate,
  parseError,
  multiStatement,
  tableAccess,
  tenantScope,
  dangerousStatement,
  postgresDialect,
  getDialect,
  type Rule,
  type Dialect,
  type EngineContext,
} from "@midplane/engine";
import { DEFAULT_PORT, PolicyFileSchema, parsePolicyYaml, type DatabaseSpec } from "./config.ts";
import { parseArgs } from "./argv.ts";
import { ensureHttpScheme, isLoopbackHost, newCliPgClient, scrub } from "./dsn.ts";

export async function runPolicy(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "init":
      return init(rest);
    case "validate":
      return validate(rest);
    case "lint":
      return lint(rest);
    case "test":
      return test(rest);
    case undefined:
    case "--help":
    case "-h":
    case "help":
      printPolicyHelp();
      return;
    default:
      process.stderr.write(`midplane policy: unknown subcommand "${sub}"\n`);
      printPolicyHelp(process.stderr);
      process.exit(2);
  }
}

// ── init ────────────────────────────────────────────────────────────────────

async function init(args: string[]): Promise<void> {
  const { flags: opts } = parseArgs(args);
  const url = opts.url;
  const tenantColumn = opts["tenant-column"];
  const outFile = opts.o ?? opts.out;

  let yamlText: string;
  if (url) {
    // Reuse the SQL the list_tables tool runs (the postgres dialect owns it).
    // We connect, read the table list, drop the connection — the DSN never
    // touches the scaffold.
    const tables = await introspectPublicTables(url);
    yamlText = scaffold({ tables, tenantColumn, introspected: true });
  } else {
    yamlText = scaffold({ tables: null, tenantColumn, introspected: false });
  }

  if (outFile) {
    // Don't clobber. A scaffold overwriting a hand-tuned policy is the kind of
    // foot-gun a security tool shouldn't ship.
    if (existsSync(outFile)) {
      process.stderr.write(
        `midplane policy: refusing to overwrite existing file "${outFile}" ` +
          `(remove it or choose another -o path)\n`,
      );
      process.exit(1);
    }
    writeFileSync(outFile, yamlText, "utf8");
    process.stderr.write(`Wrote ${outFile}\n`);
    process.stderr.write(
      `Next: midplane policy validate ${outFile} && midplane policy lint ${outFile}\n`,
    );
    return;
  }
  process.stdout.write(yamlText);
}

// Connect, read public-schema tables via the SAME query list_tables uses, then
// close. Returns the bare table names (no schema prefix). Connection failures
// exit nonzero with a terse message — never echoing the DSN.
async function introspectPublicTables(url: string): Promise<string[]> {
  // Shared CLI client: lazy `pg` (the static no-`--url` path never pays for
  // it), the bounded connect timeout, and the sslmode warning filter — one
  // copy, so doctor/init/policy can't disagree.
  const client = await newCliPgClient(url);
  try {
    await client.connect();
  } catch (err) {
    // Scrub the DSN out of any driver error that echoes it back.
    process.stderr.write(
      `midplane policy: could not connect to the database: ${scrub((err as Error).message, url)}\n`,
    );
    process.exit(1);
  }
  try {
    const sql = postgresDialect.listTablesSql!("public");
    const res = await client.query(sql);
    return (res.rows as Array<{ table_name: string }>).map((r) => r.table_name);
  } catch (err) {
    process.stderr.write(
      `midplane policy: introspection query failed: ${scrub((err as Error).message, url)}\n`,
    );
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

export interface ScaffoldOpts {
  // null ⇒ static starter (no --url); [] ⇒ connected but no public tables.
  tables: string[] | null;
  tenantColumn: string | undefined;
  introspected: boolean;
  // Wizard extensions (`midplane init`). Absent on the flag-driven path, so
  // `policy init` output is byte-identical to pre-wizard releases.
  // Per-table levels by BARE table name; unlisted tables render `read`.
  grants?: Record<string, "read" | "read_write" | "deny">;
  // tenant_scope.exempt entries. Defaults to the audit_log example.
  exempt?: string[];
}

// Exported for tests: the YAML-generation half of `init`, decoupled from the
// live-DB introspection so the "init produces a file that validates" guarantee
// can be checked without a Postgres.
export function scaffold(opts: ScaffoldOpts): string {
  const lines: string[] = [];
  const w = (s = "") => lines.push(s);

  w("# MIDPLANE_POLICY_FILE — per-table access + tenant scoping for the");
  w("# Postgres an MCP agent reaches through Midplane. Point the");
  w("# MIDPLANE_POLICY_FILE env var at this file.");
  w("#");
  w("# Out of the box (no file): every read is allowed, every write is denied.");
  w("# This file opts specific tables into writes and (optionally) turns on");
  w("# tenant scoping so cross-tenant rows can't be read or written.");
  w("#");
  w("# Workflow:");
  w("#   midplane policy validate <file>   # schema-check");
  w("#   midplane policy lint <file>       # security-posture review");
  w('#   midplane policy test <file> --sql "SELECT ..."   # dry-run a query');
  w();
  w("table_access:");
  w("  # Permission for any table NOT listed under `tables` below.");
  w("  #   read       = SELECT only (default; writes denied)");
  w("  #   read_write = SELECT + INSERT/UPDATE/DELETE");
  w("  #   deny       = no access at all (not even SELECT)");
  w("  default: read");

  if (opts.tables === null) {
    // Static starter — `tables: {}` is a valid empty record (so the file
    // validates as-is); the examples live in comments above it. Replace `{}`
    // with a block to add entries.
    w("  # Per-table overrides go under `tables`. Keys are schema-qualified");
    w("  # (public.<name>); a bare name also works. Replace `{}` below, e.g.:");
    w("  #   public.feature_flags: read_write   # let the agent toggle flags");
    w("  #   public.users: read                 # read-only");
    w("  #   public.audit_log: deny             # no access at all");
    w("  # Run `midplane policy init --url $DATABASE_URL` to scaffold from a DB.");
    w("  tables: {}");
  } else if (opts.tables.length === 0) {
    w("  tables: {}  # no tables found in the `public` schema");
  } else {
    // Every introspected user table, defaulting to read, each with the flip hint.
    // Keys are rendered through the YAML serializer (yamlKey) so a quoted
    // Postgres identifier with YAML-sensitive text (`weird: name`, a leading
    // digit, …) can't produce a file that won't parse.
    w("  tables:");
    const keys = opts.tables.map((t) => yamlKey(`public.${t}`));
    const pad = Math.max(...keys.map((k) => k.length));
    for (let i = 0; i < keys.length; i++) {
      const level = opts.grants?.[opts.tables[i]!] ?? "read";
      // The flip hint only makes sense on the default level; an explicit
      // grant/deny is already a decision.
      const hint = level === "read" ? "   # → read_write to allow writes" : "";
      w(`    ${(keys[i]! + ":").padEnd(pad + 1)} ${level}${hint}`);
    }
  }

  if (opts.tenantColumn) {
    // The column flows in from a flag or from introspected information_schema
    // metadata — route it through the YAML serializer like the table keys, so
    // a YAML-sensitive identifier can't break out of its value position (and
    // strip newlines for the comment line, which yamlKey can't protect).
    const col = yamlKey(opts.tenantColumn);
    const colComment = opts.tenantColumn.replace(/\s+/g, " ");
    w();
    w("tenant_scope:");
    w("  # Strict mode: every queried table must carry a literal");
    w(`  # \`${colComment} = <tenant_id>\` predicate, or the query is denied.`);
    w("  enabled: true");
    w(`  column: ${col}`);
    const exempt = opts.exempt ?? ["audit_log"];
    if (exempt.length === 0) {
      w("  # Tables that legitimately span tenants (audit trails, lookup tables)");
      w("  # go here; strict mode denies their queries otherwise.");
      w("  exempt: []");
    } else {
      w("  exempt:");
      w("    # Tables that legitimately span tenants (audit trails, lookup tables).");
      for (const e of exempt) w(`    - ${yamlKey(e)}`);
    }
  } else {
    w();
    w("# tenant_scope: (disabled)");
    w("#   Opt in to per-tenant isolation: declare a column every table must");
    w("#   filter on, and Midplane denies any query missing that predicate.");
    w("#   Re-run with --tenant-column <col> to scaffold it, or add:");
    w("# tenant_scope:");
    w("#   enabled: true");
    w("#   column: tenant_id");
    w("#   exempt: [audit_log]");
  }

  w();
  w("# guardrails: destructive-operation blocks that fire REGARDLESS of the");
  w("# table_access / tenant_scope policy above — the \"an agent can't nuke");
  w("# prod\" net. Both default ON (this block is shown for visibility; deleting");
  w("# it changes nothing). Set a flag to false to opt out of that block.");
  w("guardrails:");
  w("  block_unqualified_dml: true   # deny DELETE/UPDATE with no WHERE clause");
  w("  block_ddl: true               # deny DROP / TRUNCATE / ALTER");
  w();
  return lines.join("\n");
}

// ── validate ──────────────────────────────────────────────────────────────

function validate(args: string[]): void {
  const file = parseArgs(args).positionals[0];
  if (!file) {
    process.stderr.write("usage: midplane policy validate <file>\n");
    process.exit(2);
  }
  const doc = loadYamlOrExit(file);

  // An empty document is a valid (inert) policy — the loader treats it as
  // "no overrides", so we do too.
  if (doc === null || doc === undefined) {
    process.stdout.write("OK\n");
    return;
  }

  const parsed = PolicyFileSchema.safeParse(doc);
  if (!parsed.success) {
    process.stderr.write("INVALID\n");
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".") || "(root)";
      process.stderr.write(`  ${path}: ${issue.message}\n`);
    }
    process.exit(1);
  }

  // Schema-valid, but the loader applies semantic rules the schema can't
  // (mappings+overrides conflict, reserved/duplicate db names, db-name regex).
  // Surface those too.
  const semErr = semanticError(file);
  if (semErr) {
    process.stderr.write("INVALID\n");
    process.stderr.write(`  ${semErr}\n`);
    process.exit(1);
  }

  process.stdout.write("OK\n");
}

// ── lint ────────────────────────────────────────────────────────────────────

export type Severity = "error" | "warn" | "info";
export interface Finding {
  severity: Severity;
  message: string;
}

// Tables whose names look like an append-only audit trail. tenant_scope strict
// mode would block writes to them (no per-tenant predicate), so they belong in
// `exempt`. Heuristic, hence a warning not an error.
const AUDIT_TABLE_RE = /(^|[._])(audit|audit_log|audit_trail|event_log|events?_log)$/i;

function lint(args: string[]): void {
  const file = parseArgs(args).positionals[0];
  if (!file) {
    process.stderr.write("usage: midplane policy lint <file>\n");
    process.exit(2);
  }
  const doc = loadYamlOrExit(file);

  // Lint only makes sense on a VALID file; otherwise the findings would be
  // noise on top of a structural error — and, worse, a semantically-invalid
  // file that the server rejects must not green-light through lint (it would
  // weaken lint as a CI gate). Check both the schema AND the loader's semantic
  // rules (duplicate/reserved db names, mappings+overrides conflict) that the
  // schema can't express, mirroring `validate`.
  const parsed = PolicyFileSchema.safeParse(doc ?? {});
  if (!parsed.success) {
    process.stderr.write(
      `midplane policy: ${file} is not schema-valid — run \`midplane policy validate ${file}\` first\n`,
    );
    process.exit(2);
  }
  const semErr = semanticError(file);
  if (semErr) {
    process.stderr.write(
      `midplane policy: ${file} fails validation (${semErr}) — run \`midplane policy validate ${file}\` first\n`,
    );
    process.exit(2);
  }

  const findings = collectLintFindings(parsed.data);

  // Report.
  if (findings.length === 0) {
    process.stdout.write("OK — no findings\n");
    return;
  }
  const order: Severity[] = ["error", "warn", "info"];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  for (const f of findings) {
    process.stdout.write(`${tag(f.severity)} ${f.message}\n`);
  }
  const errors = findings.filter((f) => f.severity === "error").length;
  if (errors > 0) {
    process.stdout.write(`\n${errors} error-level finding${errors === 1 ? "" : "s"} — exiting nonzero.\n`);
    process.exit(1);
  }
}

// The finding computation, separated from lint()'s printing/exit so doctor
// can fold the same security-posture review into its report. One source of
// truth for what "a posture problem" means.
export function collectLintFindings(cfg: z.infer<typeof PolicyFileSchema>): Finding[] {
  const findings: Finding[] = [];

  // Each lintable unit is a (label, table_access, tenant_scope) triple — one
  // for the legacy single-DB shape, or one per `databases:` entry.
  const units: Array<{
    label: string;
    tableAccess?: z.infer<typeof PolicyFileSchema>["table_access"];
    tenantScope?: z.infer<typeof PolicyFileSchema>["tenant_scope"];
    guardrails?: z.infer<typeof PolicyFileSchema>["guardrails"];
  }> = [];
  if (cfg.databases && cfg.databases.length > 0) {
    for (const d of cfg.databases) {
      units.push({
        label: `databases.${d.name}`,
        tableAccess: d.table_access,
        tenantScope: d.tenant_scope,
        guardrails: d.guardrails,
      });
    }
  } else {
    units.push({
      label: "table_access",
      tableAccess: cfg.table_access,
      tenantScope: cfg.tenant_scope,
      guardrails: cfg.guardrails,
    });
  }

  for (const u of units) {
    const at = (s: string) => (cfg.databases ? `${u.label}: ${s}` : s);
    const ta = u.tableAccess;
    const ts = u.tenantScope;

    // default: read_write — every unlisted table is writable. The single most
    // dangerous posture (a new table is writable the moment it's created).
    if (ta?.default === "read_write") {
      findings.push({
        severity: "error",
        message: at("`table_access.default` is `read_write` — every unlisted table is writable, including tables added later. Set `default: read` and grant writes per table."),
      });
    }

    // Tables explicitly granted read_write — surface them so the author can
    // confirm each is intentional. Informational, not a problem on its own.
    const rw = Object.entries(ta?.tables ?? {})
      .filter(([, lvl]) => lvl === "read_write")
      .map(([t]) => t);
    if (rw.length > 0) {
      findings.push({
        severity: "info",
        message: at(`writes granted (read_write) to: ${rw.join(", ")}`),
      });
    }

    // tenant_scope present but disabled, or enabled without a column. Either
    // way no per-tenant predicate is enforced.
    if (ts) {
      if (ts.enabled === false) {
        findings.push({
          severity: "warn",
          message: at("`tenant_scope.enabled: false` — per-tenant isolation is OFF; queries can read/write across tenants."),
        });
      } else if (!ts.column) {
        findings.push({
          severity: "warn",
          message: at("`tenant_scope` has no `column` — only tables in `overrides` are scoped; everything else is unscoped. Set a `column` for strict mode."),
        });
      }
    } else {
      findings.push({
        severity: "warn",
        message: at("no `tenant_scope` block — no per-tenant isolation. Fine for single-tenant DBs; add one (`column:`) for multi-tenant."),
      });
    }

    // Audit-style tables that are subject to scoping (strict column set, not
    // exempt) will have their writes denied for lack of a tenant predicate.
    if (ts && ts.enabled !== false && ts.column) {
      const exempt = new Set(ts.exempt ?? []);
      const auditish = collectTableNames(ta).filter(
        (t) => AUDIT_TABLE_RE.test(t) && !exempt.has(t) && !exempt.has(bare(t)),
      );
      for (const t of auditish) {
        findings.push({
          severity: "warn",
          message: at(`\`${t}\` looks like an audit table but isn't in \`tenant_scope.exempt\` — strict scoping will deny writes to it. Add it to \`exempt\` if it spans tenants.`),
        });
      }
    }

    // Guardrails opt-outs. Omitted ⇒ both ON (the safe default) ⇒ no finding.
    // An explicit `false` re-opens a destructive class an agent can reach, so
    // surface it for review. Warning, not error — it's a deliberate operator
    // choice, but one worth seeing in the report.
    const gr = u.guardrails;
    if (gr?.block_unqualified_dml === false) {
      findings.push({
        severity: "warn",
        message: at("`guardrails.block_unqualified_dml: false` — DELETE/UPDATE with no WHERE clause are allowed on any writable table (whole-table wipes)."),
      });
    }
    if (gr?.block_ddl === false) {
      findings.push({
        severity: "warn",
        message: at("`guardrails.block_ddl: false` — DROP / TRUNCATE / ALTER are allowed on any writable table (schema destruction)."),
      });
    }

    // No deny anywhere: nothing in this unit's policy restricts beyond the
    // built-in write-block. default:read still denies writes, so this is a
    // nudge, not an error.
    const hasDeny =
      ta?.default === "deny" ||
      Object.values(ta?.tables ?? {}).some((lvl) => lvl === "deny");
    const hasScope = !!ts && ts.enabled !== false && (!!ts.column || !!(ts.overrides && Object.keys(ts.overrides).length));
    if (!hasDeny && !hasScope) {
      findings.push({
        severity: "warn",
        message: at("no `deny` rule and no tenant_scope — nothing is restricted beyond the built-in write block. Consider denying sensitive tables outright or enabling tenant_scope."),
      });
    }
  }

  return findings;
}

function tag(s: Severity): string {
  switch (s) {
    case "error":
      return "[ERROR]";
    case "warn":
      return "[WARN] ";
    case "info":
      return "[INFO] ";
  }
}

function collectTableNames(
  ta: z.infer<typeof PolicyFileSchema>["table_access"],
): string[] {
  return Object.keys(ta?.tables ?? {});
}

// `public.users` → `users`; bare stays bare. tenant_scope keys are bare
// relnames, table_access keys may be schema-qualified.
function bare(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : name;
}

// ── test ────────────────────────────────────────────────────────────────────

async function test(args: string[]): Promise<void> {
  const { positionals, flags: opts } = parseArgs(args);
  const file = positionals[0];
  // Two modes: <file> evaluates a policy FILE offline; --server asks a
  // RUNNING server's /admin/dry-run about its currently-loaded policy. The
  // two can disagree (file edited but not pushed/restarted) — that gap is
  // exactly why the second mode exists, and why mixing them is an error
  // rather than a silent pick-one.
  if (opts.server !== undefined && file) {
    process.stderr.write(
      "midplane policy test: pass a <file> (offline) OR --server (the running server's loaded policy), not both\n",
    );
    process.exit(2);
  }
  if (!file && opts.server === undefined) {
    process.stderr.write(
      'usage: midplane policy test <file> --sql "<query>" [--tenant-id <id>] [--db <name>] [--json]\n' +
        '       midplane policy test --server [url] --sql "<query>" [--token <INDEXER_TOKEN>] [--tenant-id <id>] [--db <name>] [--json]\n',
    );
    process.exit(2);
  }
  const sql = opts.sql;
  if (!sql) {
    process.stderr.write('midplane policy test: --sql "<query>" is required\n');
    process.exit(2);
  }
  // Single-tenant default mirrors the server's MIDPLANE_TENANT_ID default. The
  // tenant_scope rule compares predicate literals against THIS id, so we print
  // it in the verdict to keep the dry-run unambiguous.
  const tenantId = opts["tenant-id"] ?? "__self_host__";

  if (opts.server !== undefined) {
    return testAgainstServer(opts, sql, tenantId);
  }

  // Resolve the file through the loader (reuses the schema + semantic checks).
  // offlineEnv() supplies placeholders for any ${VAR} in databases[].url so a
  // pure policy dry-run never demands connection secrets.
  let policy;
  try {
    policy = parsePolicyYaml(readFileSync(file, "utf8"), `file ${file}`, offlineEnv());
  } catch (err) {
    process.stderr.write(`midplane policy test: ${stripPrefix((err as Error).message)}\n`);
    process.exit(1);
  }

  // Pick the DB whose policy to test.
  const spec = pickDatabase(policy.databases, opts.db);
  if (!spec) {
    const names = policy.databases.map((d) => d.name).join(", ");
    process.stderr.write(
      `midplane policy test: no database named "${opts.db}" in ${file} (have: ${names})\n`,
    );
    process.exit(2);
  }
  if (!opts.db && policy.databases.length > 1) {
    process.stderr.write(
      `(multiple databases configured; testing against "${spec.name}" — pass --db to choose another)\n`,
    );
  }

  const dialect = dialectFor(spec);

  // Same rules, in the same order, the engine wires up per DB.
  const rules: Rule[] = [
    parseError(),
    multiStatement(),
    tableAccess(spec.tableAccess ?? undefined),
    tenantScope(spec.tenantScope),
    dangerousStatement(spec.guardrails),
  ];

  const ctx: EngineContext = {
    tenant_id: tenantId,
    agent_name: null,
    agent_version: null,
    mcp_token_id: null,
    role: "agent_readonly",
  };

  const parse = await dialect.parse(sql);
  const result = evaluate({ parse, ctx, rules, dialect });

  const allowed = result.verdict.decision === "ALLOW";
  // Match the engine's agent-facing message resolution: rules supply their own
  // polished sentence; fall back to a generic one keyed off the rule name.
  const reason = allowed ? null : result.verdict.reason;
  const message = allowed
    ? null
    : result.verdict.message ?? `Midplane denied this query (rule: ${reason}).`;

  if (opts.json === "true") {
    process.stdout.write(
      JSON.stringify(
        {
          decision: result.verdict.decision,
          database: spec.name,
          dialect: dialect.name,
          tenant_id: tenantId,
          reason,
          message,
          statement_type: result.statementType,
          tables_touched: result.tablesTouched,
        },
        null,
        2,
      ) + "\n",
    );
    if (!allowed) process.exit(1);
    return;
  }

  const out = process.stdout;
  out.write(`${result.verdict.decision}\n`);
  out.write(`  database:  ${spec.name} (${dialect.name})\n`);
  out.write(`  tenant_id: ${tenantId}\n`);
  if (allowed) {
    out.write(`  statement: ${result.statementType ?? "UNKNOWN"}\n`);
    if (result.tablesTouched.length > 0) {
      out.write(`  tables:    ${result.tablesTouched.join(", ")}\n`);
    }
    out.write("  → would be sent to the database\n");
  } else {
    out.write(`  rule:      ${reason}\n`);
    out.write(`  message:   ${message}\n`);
    out.write("  → blocked; the query never reaches the database\n");
    process.exit(1);
  }
}

// ── test --server (live dry-run) ────────────────────────────────────────────

// Wire shape of one /admin/dry-run verdict (dry-run.ts owns the contract;
// declared structurally here so the CLI doesn't import transport code).
interface WireVerdict {
  sql?: string;
  decision: "allow" | "deny";
  reason: string;
  matched_rule: string;
  tables: string[];
  action: string;
}

async function testAgainstServer(
  opts: Record<string, string>,
  sql: string,
  tenantId: string,
): Promise<void> {
  const base = serverBaseUrl(opts.server);
  // The dry-run route rides the same bearer as the other admin endpoints. No
  // token, no dry-run — say so precisely instead of letting the 404 confuse.
  const token =
    opts.token && opts.token !== "true" ? opts.token : process.env.INDEXER_TOKEN;
  if (!token) {
    process.stderr.write(
      "midplane policy test: /admin/dry-run requires the server's INDEXER_TOKEN " +
        "(pass --token <token> or set INDEXER_TOKEN). Without one, test the policy " +
        "file offline: midplane policy test <file> --sql ...\n",
    );
    process.exit(2);
  }
  const db = opts.db ?? "__default__";

  // INDEXER_TOKEN is the bearer for the WHOLE admin surface — a passive
  // observer who reads it off plaintext http can hot-swap policy. Loopback
  // is fine (the token never leaves the machine); anything else fails
  // closed unless the operator explicitly opts in (private docker/LAN nets
  // are legitimate, but that's their call to make, not a default).
  const baseUrl = new URL(base);
  if (baseUrl.protocol === "http:" && !isLoopbackHost(baseUrl.hostname)) {
    if (opts["allow-http"] !== "true") {
      process.stderr.write(
        `midplane policy test: refusing to send INDEXER_TOKEN over plaintext http to ${baseUrl.hostname} ` +
          `(it grants admin access — /admin/policy hot-swap included). Use https, or pass --allow-http ` +
          `if this is a trusted private network.\n`,
      );
      process.exit(2);
    }
    process.stderr.write(
      `(warning: sending INDEXER_TOKEN over plaintext http to ${baseUrl.hostname})\n`,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${base}/admin/dry-run`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        database: db,
        sql,
        tenant_context: { value: tenantId },
      }),
      // A wedged server (accepts TCP, never answers) must not hang the CLI.
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    process.stderr.write(
      `midplane policy test: cannot reach ${base} — is the server running? (\`midplane doctor\` checks this)\n`,
    );
    process.exit(1);
  }

  if (res.status === 404) {
    // The route 404s when the server booted without INDEXER_TOKEN — the
    // admin surface is opt-in and reveals nothing when off.
    process.stderr.write(
      `midplane policy test: ${base} has no admin endpoints (server running without INDEXER_TOKEN?)\n`,
    );
    process.exit(1);
  }
  if (res.status === 401) {
    process.stderr.write("midplane policy test: unauthorized — wrong INDEXER_TOKEN\n");
    process.exit(1);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const errMsg = body?.error ?? "unknown error";
    process.stderr.write(
      `midplane policy test: server returned ${res.status}: ${errMsg}\n`,
    );
    // Multi-DB servers never register the synthetic single-DB name; the
    // default only fits the legacy shape. Make the fix obvious — the server
    // already listed its real names in the error.
    if (!opts.db && /Unknown database "__default__"/.test(errMsg)) {
      process.stderr.write(
        "  (this server runs a multi-database config — pass --db <name> with one of the names above)\n",
      );
    }
    process.exit(1);
  }

  // Don't dereference a shape we didn't verify — a version-skewed server (or
  // anything else answering 200 on that path) must produce a precise error,
  // not an uncaught TypeError.
  const data = (await res.json().catch(() => null)) as
    | { verdicts?: WireVerdict[]; policy_hash?: string }
    | null;
  const v = Array.isArray(data?.verdicts) ? data.verdicts[0] : undefined;
  if (!v) {
    process.stderr.write(
      `midplane policy test: unexpected response from ${base}/admin/dry-run (no verdicts) — server version mismatch?\n`,
    );
    process.exit(1);
  }
  const allowed = v.decision === "allow";

  if (opts.json === "true") {
    process.stdout.write(
      JSON.stringify(
        {
          decision: allowed ? "ALLOW" : "DENY",
          server: base,
          database: db,
          tenant_id: tenantId,
          matched_rule: v.matched_rule,
          reason: v.reason,
          statement_type: v.action,
          tables_touched: v.tables,
          policy_hash: data.policy_hash,
        },
        null,
        2,
      ) + "\n",
    );
    if (!allowed) process.exit(1);
    return;
  }

  const out = process.stdout;
  out.write(`${allowed ? "ALLOW" : "DENY"}\n`);
  out.write(`  server:    ${base} (loaded policy ${data.policy_hash})\n`);
  out.write(`  database:  ${db}\n`);
  out.write(`  tenant_id: ${tenantId}\n`);
  if (allowed) {
    out.write(`  statement: ${v.action}\n`);
    if (v.tables.length > 0) out.write(`  tables:    ${v.tables.join(", ")}\n`);
    out.write("  → would be sent to the database\n");
  } else {
    out.write(`  rule:      ${v.matched_rule}\n`);
    out.write(`  reason:    ${v.reason}\n`);
    out.write("  → blocked; the query never reaches the database\n");
    process.exit(1);
  }
}

// `--server` accepts a bare flag (default localhost), host:port, or a full
// URL; only the origin is kept — the dry-run path is fixed. A value that
// won't parse as a URL is a usage error, not a stack trace.
function serverBaseUrl(raw: string | undefined): string {
  if (!raw || raw === "true") return `http://localhost:${process.env.PORT ?? DEFAULT_PORT}`;
  try {
    return new URL(ensureHttpScheme(raw)).origin;
  } catch {
    process.stderr.write(`midplane policy test: invalid --server URL "${raw}"\n`);
    process.exit(2);
  }
}

function pickDatabase(databases: DatabaseSpec[], db: string | undefined): DatabaseSpec | undefined {
  if (db) return databases.find((d) => d.name === db);
  return databases[0];
}

function dialectFor(spec: DatabaseSpec): Dialect {
  // Postgres-only public build; the seam resolves the one registered dialect.
  return getDialect(spec.dialect);
}

// ── shared helpers ───────────────────────────────────────────────────────────

function loadYamlOrExit(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    process.stderr.write(`midplane policy: cannot read ${file}: ${(err as Error).message}\n`);
    process.exit(1);
  }
  try {
    return yaml.load(text);
  } catch (err) {
    process.stderr.write(`midplane policy: ${file} is not valid YAML: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// Strip the "Policy schema error from file X:" / "Policy YAML ... :" prefix the
// loader bakes into thrown errors so CLI output isn't doubly redundant.
// Exported for doctor, which reports the same loader errors.
export function stripPrefix(msg: string): string {
  return msg.replace(/^Policy (?:schema|YAML)[^:]*:\s*/, "");
}

// An env that never throws on `${VAR}` interpolation: real vars pass through,
// unset ones resolve to a harmless placeholder. Used by validate/test so an
// offline check of a file with `${DATABASE_URL}` doesn't require the secret.
function offlineEnv(): NodeJS.ProcessEnv {
  return new Proxy(process.env, {
    get(target, prop: string) {
      const v = target[prop];
      return v !== undefined && v !== "" ? v : "midplane-policy-cli-offline";
    },
  });
}

// Run the loader's SEMANTIC validation — the checks the zod schema can't
// express (mappings+overrides conflict, reserved/duplicate db names, db-name
// regex). Returns the cleaned error message, or null when the file passes.
// Env-var interpolation failures are treated as a pass: they only matter at
// connect time, not for an offline structural check. Shared by validate and
// lint so a file that the server (and `validate`) rejects can't slip through
// lint with exit 0.
function semanticError(file: string): string | null {
  try {
    parsePolicyYaml(readFileSync(file, "utf8"), `file ${file}`, offlineEnv());
    return null;
  } catch (err) {
    const msg = (err as Error).message;
    if (/references env var/.test(msg)) return null;
    return stripPrefix(msg);
  }
}

// Render an arbitrary string as a YAML mapping key via the serializer: plain-
// safe names pass through, anything YAML-sensitive is quoted/escaped. Keeps
// generated table keys on one line (lineWidth: -1) so they fit the scaffold's
// `key: read  # hint` template.
function yamlKey(s: string): string {
  return yaml.dump(s, { lineWidth: -1 }).trimEnd();
}

export function printPolicyHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`midplane policy — author, validate, and dry-run a MIDPLANE_POLICY_FILE

Usage:
  midplane policy init [--url \$DATABASE_URL] [--tenant-column <col>] [-o <file>]
      Scaffold a commented policy file. With --url, connect and list every
      table in the \`public\` schema (read-only) and emit each under
      table_access (default: read). With --tenant-column, emit a strict
      tenant_scope block on that column (exempt: [audit_log]). Without -o,
      print to stdout. The DSN is never printed or written to the file.

  midplane policy validate <file>
      Parse the YAML and check it against the policy schema the server boots
      with. Prints "OK", or "INVALID" + each error (path + message). Exit
      nonzero on invalid.

  midplane policy lint <file>
      Security-posture findings beyond schema validity: read_write defaults,
      tables granted writes, missing/disabled tenant_scope, audit tables left
      scoped, policies that restrict nothing. Exit nonzero on any [ERROR];
      warnings exit 0.

  midplane policy test <file> --sql "<query>" [--tenant-id <id>] [--db <name>] [--json]
      Run a query through the engine's real policy evaluation against the
      file's policy — no DB connection. Prints ALLOW/DENY, the rule, and the
      exact agent-facing message a denial would return. Exit nonzero on DENY.

  midplane policy test --server [url] --sql "<query>" [--token <t>] [--tenant-id <id>] [--db <name>] [--json]
      Same question, asked of a RUNNING server's currently-LOADED policy via
      POST /admin/dry-run (default url http://localhost:\$PORT). The file on
      disk and the loaded policy can differ — this is how you check the live
      one. Requires the server's INDEXER_TOKEN (--token or env). Multi-DB
      servers: --db <name> (default __default__). The token is only sent over
      https or to localhost; --allow-http opts in for trusted private nets.
`);
}
