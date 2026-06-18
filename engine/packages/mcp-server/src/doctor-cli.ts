// `midplane doctor` — preflight and smoke checks for an install, in the
// order things fail in the field: env config → policy file → database
// reachability → audit store → running server → end-to-end canary.
//
// Doctor never fixes anything; it reports. Each check is ok/warn/fail/info;
// any FAIL exits nonzero. The text output is the artifact people paste into
// a GitHub issue, so it's deterministic, DSN-scrubbed, and complete.
//
// The canary is a real `SELECT 1` through the running server's MCP `query`
// tool (query-cli's client) — it writes an audit row, deliberately: proving
// the audit pipeline records the call IS the check. `--no-canary` skips it.

import { existsSync, readFileSync } from "node:fs";
import { SqliteAuditWriter } from "@midplane/engine";
import {
  loadConfig,
  parsePolicyYaml,
  resolveDatabasesFromConfig,
  PolicyFileSchema,
  DEFAULT_PORT,
  type Config,
  type DatabaseSpec,
  type LoadedPolicy,
} from "./config.ts";
import { collectLintFindings, stripPrefix } from "./policy-cli.ts";
import { parseArgs } from "./argv.ts";
import { paletteFor, type Palette } from "./render.ts";
import { displayHost, ensureHttpScheme, newCliPgClient, scrub } from "./dsn.ts";
import { version as PACKAGE_VERSION } from "../package.json" with { type: "json" };

type Status = "ok" | "warn" | "fail" | "info";

interface Check {
  name: string;
  status: Status;
  detail: string;
}

const HEALTH_TIMEOUT_MS = 3000;

export async function runDoctor(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  if (flags.help === "true") {
    printDoctorHelp();
    return;
  }
  const checks: Check[] = [];
  const push = (name: string, status: Status, detail: string) =>
    checks.push({ name, status, detail });

  push("version", "info", `midplane ${PACKAGE_VERSION} (bun ${Bun.version})`);

  // ── 1. env config — the exact loader the server boots with ──────────────
  let cfg: Config | null = null;
  try {
    cfg = loadConfig(process.env);
    push(
      "config",
      "ok",
      `transport=${cfg.transport} port=${cfg.port}` +
        (cfg.policyFile ? ` policy=${cfg.policyFile}` : ""),
    );
  } catch (err) {
    push("config", "fail", (err as Error).message);
  }

  // ── 2. policy file — same parse + semantic rules as boot, plus lint ─────
  let policy: LoadedPolicy | null = null;
  if (cfg?.policyFile) {
    try {
      // process.env on purpose (not the offline proxy): doctor verifies the
      // REAL boot path, so an unset ${VAR} in databases[].url must fail here
      // exactly as it would at server start.
      const text = readFileSync(cfg.policyFile, "utf8");
      policy = parsePolicyYaml(text, `file ${cfg.policyFile}`, process.env);
      const parsed = PolicyFileSchema.safeParse(
        (await import("js-yaml")).default.load(text) ?? {},
      );
      const findings = parsed.success ? collectLintFindings(parsed.data) : [];
      const errors = findings.filter((f) => f.severity === "error").length;
      const warns = findings.filter((f) => f.severity === "warn").length;
      const infos = findings.filter((f) => f.severity === "info").length;
      if (errors > 0) {
        push("policy", "fail", `${cfg.policyFile} valid, but lint found ${errors} error${errors === 1 ? "" : "s"} — run \`midplane policy lint ${cfg.policyFile}\``);
      } else if (warns > 0) {
        push("policy", "warn", `${cfg.policyFile} valid; lint: ${warns} warning${warns === 1 ? "" : "s"} (\`midplane policy lint ${cfg.policyFile}\`)`);
      } else if (infos > 0) {
        // Info-level findings (e.g. "writes granted to X") aren't problems, but
        // claiming "no findings" while `policy lint` lists them is a lie — name
        // them as notes and point at the full report.
        push("policy", "ok", `${cfg.policyFile} valid; lint: ${infos} note${infos === 1 ? "" : "s"} (\`midplane policy lint ${cfg.policyFile}\`)`);
      } else {
        push("policy", "ok", `${cfg.policyFile} valid, no lint findings`);
      }
    } catch (err) {
      push("policy", "fail", stripPrefix((err as Error).message));
    }
  } else if (cfg) {
    push(
      "policy",
      "info",
      "MIDPLANE_POLICY_FILE not set — default policy (reads allowed, writes denied, no tenant scoping)",
    );
  }

  // ── 3. databases — connect + SELECT 1 per configured DB ─────────────────
  let databases: DatabaseSpec[] = [];
  if (cfg) {
    try {
      const loaded = policy ?? parsePolicyYaml("", "defaults", process.env);
      databases = resolveDatabasesFromConfig(loaded, cfg);
    } catch (err) {
      push("database", "fail", (err as Error).message);
    }
  }
  // Ping concurrently — several unreachable DSNs (exactly what doctor
  // diagnoses) must cost one connect timeout, not one per database. Results
  // are pushed in config order so the report stays deterministic.
  const pings = await Promise.allSettled(databases.map((spec) => pingPostgres(spec.url)));
  databases.forEach((spec, i) => {
    const label = databases.length > 1 ? `database ${spec.name}` : "database";
    const where = displayHost(spec.url);
    const ping = pings[i]!;
    if (ping.status === "fulfilled") {
      push(label, "ok", `${spec.name}: connected (${where})`);
    } else {
      const msg = ping.reason instanceof Error ? ping.reason.message : String(ping.reason);
      push(label, "fail", `${spec.name}: ${scrub(msg, spec.url)} (${where})`);
    }
  });

  // ── 4. audit store ───────────────────────────────────────────────────────
  if (cfg) {
    if (!existsSync(cfg.dbPath)) {
      push("audit db", "warn", `${cfg.dbPath} does not exist yet (created at first server boot)`);
    } else {
      try {
        const w = new SqliteAuditWriter(cfg.dbPath, { create: false });
        w.close();
        push("audit db", "ok", cfg.dbPath);
      } catch (err) {
        push("audit db", "fail", `${cfg.dbPath}: ${(err as Error).message}`);
      }
    }
  }

  // ── 5. server + canary ───────────────────────────────────────────────────
  // An explicit --server overrides the transport heuristic: the operator is
  // pointing doctor at a running HTTP server, and "transport=stdio locally"
  // must not silently skip the check they asked for.
  if (cfg && (cfg.transport === "http" || flags.server)) {
    const base = flags.server
      ? originOf(flags.server)
      : `http://localhost:${cfg.port}`;
    let healthy = false;
    try {
      const res = await fetch(`${base}/health`, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      healthy = res.ok;
      push("server", healthy ? "ok" : "fail", `${base}/health → ${res.status}`);
    } catch {
      // Implicit check (default localhost) → warn: doctor legitimately runs
      // before the server starts. EXPLICIT --server → fail: the operator
      // asked us to verify that endpoint, and "No failures" with nothing
      // listening there would be a lie.
      push(
        "server",
        flags.server ? "fail" : "warn",
        `nothing responding at ${base} — start it with \`midplane server\`` +
          (flags.server ? "" : " (or point doctor with --server)"),
      );
    }

    if (healthy && flags.canary !== "false") {
      try {
        const { mcpQuery } = await import("./query-cli.ts");
        // Multi-DB servers register the query tool with a REQUIRED
        // `database` enum — an argument-less canary would fail schema
        // validation on a perfectly healthy server. Use the first locally
        // configured name (the docker-exec common case shares the config);
        // single-DB servers get no database arg, matching their schema.
        const result = await mcpQuery(
          { serverUrl: `${base}/mcp` },
          {
            sql: "SELECT 1",
            intent: "midplane doctor end-to-end canary",
            database: databases.length > 1 ? databases[0]!.name : undefined,
          },
        );
        if (result.allowed) {
          push("canary", "ok", `SELECT 1 through MCP → ALLOW (audit ${result.auditId ?? "?"})`);
        } else {
          push("canary", "warn", `SELECT 1 was denied (rule ${result.policy_rule}) — unusual; check the policy`);
        }
      } catch (err) {
        push("canary", "fail", `MCP query failed: ${(err as Error).message}`);
      }
    }
  } else if (cfg) {
    push(
      "server",
      "info",
      'transport=stdio — the agent spawns the server; verify with `midplane query --stdio --sql "SELECT 1"`',
    );
  }

  // ── 6. admin surface posture ─────────────────────────────────────────────
  push(
    "admin",
    "info",
    process.env.INDEXER_TOKEN
      ? "INDEXER_TOKEN set — /admin/policy, /admin/dry-run, /audit/since enabled"
      : "INDEXER_TOKEN unset — admin endpoints disabled (policy push + live dry-run unavailable)",
  );

  report(checks, flags);
}

function report(checks: Check[], flags: Record<string, string>): void {
  const failed = checks.some((c) => c.status === "fail");
  if (flags.json === "true") {
    process.stdout.write(JSON.stringify({ ok: !failed, checks }, null, 2) + "\n");
    if (failed) process.exit(1);
    return;
  }
  const p = paletteFor(true);
  const out = process.stdout;
  out.write(`midplane doctor\n\n`);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    out.write(`  ${mark(c.status, p)} ${c.name.padEnd(width)}  ${c.detail}\n`);
  }
  const warns = checks.filter((c) => c.status === "warn").length;
  out.write("\n");
  if (failed) {
    out.write(p.red("Problems found — fix the ✗ lines above.\n"));
    process.exit(1);
  }
  out.write(
    (warns > 0 ? `${warns} warning${warns === 1 ? "" : "s"}. ` : "") +
      "No failures.\n",
  );
}

function mark(s: Status, p: Palette): string {
  switch (s) {
    case "ok":
      return p.green("✓");
    case "warn":
      return p.yellow("!");
    case "fail":
      return p.red("✗");
    case "info":
      return p.dim("·");
  }
}

// Connect → SELECT 1 → end. Uses the shared CLI client (lazy pg, bounded
// connect timeout so a firewalled host fails in seconds not minutes).
async function pingPostgres(url: string): Promise<void> {
  const client = await newCliPgClient(url);
  await client.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    await client.end().catch(() => {});
  }
}

// `--server` value → origin. A bare `--server` (no value) means "the
// default"; an unparseable value is a usage error, not a stack trace.
function originOf(raw: string): string {
  if (raw === "true") return `http://localhost:${process.env.PORT ?? DEFAULT_PORT}`;
  try {
    return new URL(ensureHttpScheme(raw)).origin;
  } catch {
    process.stderr.write(`midplane doctor: invalid --server URL "${raw}"\n`);
    process.exit(2);
  }
}

export function printDoctorHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`midplane doctor — preflight and smoke checks for this install

Checks, in boot order: env config, policy file (validate + lint), database
connectivity (SELECT 1 per configured DB), audit store, running server
(/health), and an end-to-end MCP canary (SELECT 1 through the real query
tool — it writes an audit row on purpose; that's the proof).

Usage:
  midplane doctor [--server <url>] [--no-canary] [--json]

  --server <url>   Where the running server lives (default http://localhost:\$PORT).
  --no-canary      Skip the end-to-end MCP query.
  --json           Machine-readable {ok, checks} instead of text.

Exit codes: 0 when nothing failed (warnings allowed), 1 on any failure.
`);
}
