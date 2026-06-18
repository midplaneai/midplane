// `midplane init` — interactive first-run setup: connect to the database,
// detect the tenant column, choose grants, write a validated policy file,
// and print the exact next commands (server, agent config, verification).
//
// This is the 60-second install made real. The flag-driven equivalent is
// `midplane policy init` (same scaffold generator underneath — the wizard
// only ever ANSWERS the same questions interactively); CI and scripts should
// use that. The wizard requires a TTY and says so otherwise.
//
// Security posture mirrors `policy init`: the DSN comes from the env or a
// masked prompt, is used for read-only information_schema introspection, and
// is never echoed or written to the file. Connection errors are scrubbed.
//
// @clack/prompts is the one interactive dependency the CLI allows itself
// (tiny, prompt-only). It must never be imported by the server path.

import {
  intro,
  outro,
  text,
  password,
  select,
  multiselect,
  confirm,
  spinner,
  note,
  isCancel,
  cancel,
  log,
} from "@clack/prompts";
import { existsSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import { postgresDialect } from "@midplane/engine";
import { parseArgs } from "./argv.ts";
import { scaffold, collectLintFindings } from "./policy-cli.ts";
import { PolicyFileSchema } from "./config.ts";
import { displayHost, newCliPgClient, scrub } from "./dsn.ts";

const DEFAULT_OUT = "midplane.policy.yaml";

// ── tenant-column detection ──────────────────────────────────────────────────

// Column names that plausibly mean "which customer owns this row", in
// preference order. Exact matches only — a fuzzy net would drag in FKs like
// `user_id` and erode trust in the suggestion. Anything containing "tenant"
// also qualifies (tenant_uuid, tenantid, ...).
const PRIORITY = [
  "tenant_id",
  "org_id",
  "organization_id",
  "workspace_id",
  "account_id",
  "team_id",
  "company_id",
  "customer_id",
];
const TENANTISH = /tenant/i;

export interface ColumnRow {
  table_name: string;
  column_name: string;
}

export interface TenantCandidate {
  column: string;
  // Tables (bare names, sorted) that carry the column.
  tables: string[];
  total: number;
}

// Rank candidate tenant columns by coverage (how many tables carry them),
// then by name preference. Pure — the wizard's only logic worth unit-testing
// without a terminal.
export function rankTenantCandidates(
  columns: ColumnRow[],
  allTables: string[],
): TenantCandidate[] {
  const known = new Set(allTables);
  const byColumn = new Map<string, Set<string>>();
  for (const { table_name, column_name } of columns) {
    if (!known.has(table_name)) continue; // views etc. — not in the table list
    const c = column_name.toLowerCase();
    if (!PRIORITY.includes(c) && !TENANTISH.test(c)) continue;
    let set = byColumn.get(c);
    if (!set) byColumn.set(c, (set = new Set()));
    set.add(table_name);
  }
  const prio = (c: string) => {
    const i = PRIORITY.indexOf(c);
    return i === -1 ? PRIORITY.length : i;
  };
  return [...byColumn.entries()]
    .map(([column, tables]) => ({
      column,
      tables: [...tables].sort(),
      total: allTables.length,
    }))
    .sort((a, b) => b.tables.length - a.tables.length || prio(a.column) - prio(b.column));
}

// ── wizard ───────────────────────────────────────────────────────────────────

export async function runInit(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  if (flags.help === "true") {
    printInitHelp();
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "midplane init is interactive and needs a terminal.\n" +
        "For scripts/CI use the flag-driven scaffold: midplane policy init --url $DATABASE_URL [--tenant-column <col>] -o midplane.policy.yaml\n",
    );
    process.exit(2);
  }

  intro("midplane init — write a policy for your database");

  // ── DSN: env first, masked prompt otherwise; never echoed ────────────────
  let url = flags.url ?? process.env.DATABASE_URL;
  if (url && !flags.url) {
    const useEnv = must(
      await confirm({
        message: `Use DATABASE_URL from the environment? (${displayHost(url)})`,
      }),
    );
    if (!useEnv) url = undefined;
  }
  if (!url) {
    url = must(
      await password({
        message: "Postgres DSN (stays in your env — never written to the file)",
        validate: (v) => (v && v.length > 0 ? undefined : "a DSN is required"),
      }),
    );
  }

  // ── introspect: tables + columns, read-only, one connection ──────────────
  const s = spinner();
  s.start("Connecting and reading information_schema");
  let tables: string[];
  let columns: ColumnRow[];
  try {
    ({ tables, columns } = await introspect(url));
  } catch (err) {
    s.stop("Connection failed");
    cancel(`Could not introspect the database: ${scrub((err as Error).message, url)}`);
    process.exit(1);
  }
  s.stop(`Connected — ${tables.length} table${tables.length === 1 ? "" : "s"} in schema \`public\``);

  if (tables.length === 0) {
    log.warn(
      "No tables found in `public`. The policy will still be written; re-run after your schema exists, or edit the file by hand.",
    );
  }

  // ── tenant scoping: the hero question ────────────────────────────────────
  let tenantColumn: string | undefined;
  let exempt: string[] = [];
  const candidates = rankTenantCandidates(columns, tables);

  if (flags["tenant-column"]) {
    tenantColumn = flags["tenant-column"];
  } else if (tables.length > 0) {
    const options: Array<{ value: string; label: string; hint?: string }> = candidates
      .slice(0, 5)
      .map((c) => ({
        value: c.column,
        label: `${c.column} — on ${c.tables.length}/${c.total} tables`,
        hint:
          c.tables.length === c.total
            ? "full coverage"
            : `missing on: ${preview(uncovered(c, tables))}`,
      }));
    options.push({ value: "__other__", label: "another column…" });
    options.push({
      value: "__skip__",
      label: "skip — no tenant isolation",
      hint: "single-tenant databases",
    });
    const choice = must(
      await select({
        message:
          "Tenant scoping: pick the column every query must filter on (cross-tenant queries get denied)",
        options,
      }),
    );
    if (choice === "__other__") {
      tenantColumn = must(
        await text({
          message: "Tenant column name",
          placeholder: "tenant_id",
          validate: (v) => (v && v.trim().length > 0 ? undefined : "a column name is required"),
        }),
      ).trim();
    } else if (choice !== "__skip__") {
      tenantColumn = choice;
    }
  }

  if (tenantColumn) {
    const candidate = candidates.find((c) => c.column === tenantColumn);
    const missing = candidate ? uncovered(candidate, tables) : [];
    if (missing.length > 0) {
      // Strict mode denies every query on a scoped table that lacks the
      // predicate — a table without the column can never satisfy it, so
      // leaving it scoped means bricking it (which IS the safe default for
      // tables that should have had the column).
      const chosen = must(
        await multiselect({
          message: `${missing.length} table${missing.length === 1 ? "" : "s"} don't have \`${tenantColumn}\` — exempt the ones that legitimately span tenants (unexempted ones will deny)`,
          options: missing.map((t) => ({ value: t, label: t })),
          initialValues: missing,
          required: false,
        }),
      );
      exempt = chosen;
    }
  }

  // ── write grants ──────────────────────────────────────────────────────────
  const grants: Record<string, "read" | "read_write" | "deny"> = {};
  if (tables.length > 0) {
    const writable = must(
      await multiselect({
        message: "Tables the agent may WRITE to (everything else stays read-only)",
        options: tables.map((t) => ({ value: t, label: t })),
        required: false,
      }),
    );
    for (const t of writable) grants[t] = "read_write";

    const denyable = tables.filter((t) => grants[t] === undefined);
    if (denyable.length > 0) {
      const denied = must(
        await multiselect({
          message: "Tables to deny entirely — not even SELECT (secrets, internal audit, ...)",
          options: denyable.map((t) => ({ value: t, label: t })),
          required: false,
        }),
      );
      for (const t of denied) grants[t] = "deny";
    }
  }

  // ── output path ───────────────────────────────────────────────────────────
  let outFile = flags.o ?? flags.out;
  if (!outFile) {
    outFile = must(
      await text({
        message: "Write the policy to",
        initialValue: DEFAULT_OUT,
        validate: (v) => (v && v.trim().length > 0 ? undefined : "a path is required"),
      }),
    ).trim();
  }
  if (existsSync(outFile)) {
    const overwrite = must(
      await confirm({ message: `${outFile} exists — overwrite it?`, initialValue: false }),
    );
    if (!overwrite) {
      cancel("Nothing written.");
      process.exit(1);
    }
  }

  // ── generate, self-validate, lint, write ─────────────────────────────────
  const yamlText = scaffold({
    tables,
    tenantColumn,
    introspected: true,
    grants,
    exempt: tenantColumn ? exempt : undefined,
  });

  // The generator and the schema live in different files; a scaffold that
  // doesn't validate is a bug, not a user error — fail loudly before writing.
  const parsed = PolicyFileSchema.safeParse(yaml.load(yamlText) ?? {});
  if (!parsed.success) {
    cancel(`internal error: generated policy failed validation — please report this.\n${parsed.error.message}`);
    process.exit(1);
  }

  writeFileSync(outFile, yamlText, "utf8");

  const findings = collectLintFindings(parsed.data);
  const warns = findings.filter((f) => f.severity !== "info");
  if (warns.length > 0) {
    note(
      warns.map((f) => `${f.severity === "error" ? "✗" : "!"} ${f.message}`).join("\n"),
      "lint",
    );
  }

  note(
    [
      "Run the server (docker):",
      "  docker run --env-file .env -p 8080:8080 \\",
      "    -v midplane-audit:/data \\",
      `    -v ./${outFile}:/policy.yaml -e MIDPLANE_POLICY_FILE=/policy.yaml \\`,
      "    midplane/midplane:latest",
      "",
      "Point your agent at it:",
      "  claude mcp add --transport http midplane http://localhost:8080/mcp",
      '  (Cursor: add {"url": "http://localhost:8080/mcp"} under mcpServers)',
      "",
      "Verify end to end:",
      "  midplane doctor",
      '  midplane query --sql "SELECT 1"',
    ].join("\n"),
    "next steps",
  );

  outro(`Wrote ${outFile} — the DSN stays in your env, never in the file.`);
}

// Clack returns a cancel symbol when the user hits ctrl-c/esc; every answer
// goes through this gate so abort means abort (nothing written).
function must<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel("Setup aborted — nothing written.");
    process.exit(1);
  }
  return value as T;
}

async function introspect(
  url: string,
): Promise<{ tables: string[]; columns: ColumnRow[] }> {
  // Shared CLI client (lazy pg, bounded connect timeout, sslmode warning
  // filtered) — and the SAME table query the list_tables tool runs (the
  // dialect owns it).
  const client = await newCliPgClient(url);
  await client.connect();
  try {
    const tablesRes = await client.query(postgresDialect.listTablesSql!("public"));
    const tables = (tablesRes.rows as Array<{ table_name: string }>).map((r) => r.table_name);
    const colsRes = await client.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
    );
    return { tables, columns: colsRes.rows as ColumnRow[] };
  } finally {
    await client.end().catch(() => {});
  }
}

function uncovered(c: TenantCandidate, allTables: string[]): string[] {
  const has = new Set(c.tables);
  return allTables.filter((t) => !has.has(t));
}

function preview(items: string[], n = 3): string {
  return items.slice(0, n).join(", ") + (items.length > n ? ", …" : "");
}

export function printInitHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`midplane init — interactive setup: introspect your DB, write a policy

Connects with your DATABASE_URL (or a masked prompt), detects likely tenant
columns (tenant_id, org_id, ... — shown with table coverage), lets you pick
write grants and denies per table, writes a validated policy file, and
prints the docker + agent-config commands to finish.

Usage:
  midplane init [--url <dsn>] [--tenant-column <col>] [-o <file>]

Needs a TTY. For scripts/CI use: midplane policy init (same generator,
flags only). The DSN is never written to the policy file.
`);
}
