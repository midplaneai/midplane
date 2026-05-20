// `midplane audit` — read the local SQLite audit log without writing SQL.
//
// Three subcommands, all read-only against DB_PATH (default /data/audit.db):
//   tail   — backfill recent rows + poll for new ones (JSON lines)
//   since  — one-shot dump of rows newer than a duration window
//   stats  — group-by summary over a window (event types, deny rules, etc.)
//
// We open SQLite directly with `bun:sqlite` rather than going through the
// HTTP /audit/since endpoint because (a) `docker exec` is already inside the
// container, and (b) the HTTP path requires INDEXER_TOKEN, which a self-host
// admin shouldn't need to provision just to read their own log.

import { Database } from "bun:sqlite";
import { SqliteAuditWriter } from "@midplane/engine";

const DEFAULT_DB_PATH = "/data/audit.db";
// Override only used by the regression test for the rowid-cursor fix.
const TAIL_POLL_MS = Number(process.env.MIDPLANE_AUDIT_TAIL_POLL_MS) || 1000;
const TAIL_BACKFILL_DEFAULT = 10;

interface RawRow {
  rowid: number;
  id: string;
  query_id: string;
  tenant_id: string;
  database: string;
  agent_name: string | null;
  agent_version: string | null;
  agent_intent: string | null;
  mcp_token_id: string | null;
  ts: number;
  event_type: string;
  payload: string;
  schema_version: number;
}

interface StatsRow {
  k: string | null;
  n: number;
}

export async function runAudit(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "tail":
      return tail(rest);
    case "stats":
      return stats(rest);
    case "since":
      return since(rest);
    case undefined:
    case "--help":
    case "-h":
    case "help":
      printAuditHelp();
      return;
    default:
      process.stderr.write(`midplane audit: unknown subcommand "${sub}"\n`);
      printAuditHelp(process.stderr);
      process.exit(2);
  }
}

function dbPath(): string {
  return process.env.DB_PATH ?? DEFAULT_DB_PATH;
}

function openDb(): Database {
  // Run schema migrations BEFORE the read-only handle opens. An operator
  // who upgraded the binary to 0.3.x but whose audit DB is still 0.2-shape
  // would otherwise hit `no such column: agent_name` on the very first
  // SELECT — the CLI's column list assumes the post-migration shape. By
  // constructing an SqliteAuditWriter here we let its applySchema() walk
  // the same in-place ALTERs the server runs at boot. The writer is
  // closed immediately; subsequent opens hit the fast-path (every
  // hasColumn() check returns true, no ALTERs run).
  try {
    const migrator = new SqliteAuditWriter(dbPath(), { create: false });
    migrator.close();
  } catch (err) {
    process.stderr.write(
      `midplane audit: cannot open ${dbPath()}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  // readwrite (not readonly) because the audit DB is in WAL mode: a pure
  // readonly connection can't initialize the -shm file when no writer is
  // attached, and fails with SQLITE_CANTOPEN on the first query. We compensate
  // with `PRAGMA query_only` so any mutating SQL would error out.
  // create:false surfaces a friendly error instead of silently creating an
  // empty DB on a typo'd DB_PATH.
  let db: Database;
  try {
    db = new Database(dbPath(), { readwrite: true, create: false });
  } catch (err) {
    process.stderr.write(
      `midplane audit: cannot open ${dbPath()}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }
  db.run("PRAGMA query_only = 1");
  return db;
}

function rowToJson(r: RawRow): string {
  return JSON.stringify({
    id: r.id,
    query_id: r.query_id,
    tenant_id: r.tenant_id,
    database: r.database,
    agent_name: r.agent_name,
    agent_version: r.agent_version,
    agent_intent: r.agent_intent,
    mcp_token_id: r.mcp_token_id,
    ts: r.ts,
    event_type: r.event_type,
    payload: JSON.parse(r.payload),
    schema_version: r.schema_version,
  });
}

// Cursor by `rowid` (SQLite's implicit insertion counter) rather than `id`.
// `id` is a ULID — sortable by ms-timestamp prefix but with a random suffix,
// so two rows committed in the same millisecond are NOT monotonic relative
// to each other. A cursor of `WHERE id > ?` would permanently skip a later
// insert whose random suffix happens to sort below the previously emitted id.
// `rowid` is strictly monotonic for new inserts, which is what tail needs.
const SELECT_COLS =
  "rowid, id, query_id, tenant_id, database, agent_name, agent_version, agent_intent, mcp_token_id, ts, event_type, payload, schema_version";

async function tail(args: string[]): Promise<void> {
  const opts = parseFlags(args, { backfill: String(TAIL_BACKFILL_DEFAULT), follow: "true" });
  const backfill = Math.max(0, Number.parseInt(opts.backfill ?? "", 10) || 0);
  const follow = opts.follow !== "false";
  const db = openDb();

  let cursor = 0;
  if (backfill > 0) {
    const recent = db
      .query<RawRow, [number]>(
        `SELECT ${SELECT_COLS} FROM audit_events ORDER BY rowid DESC LIMIT ?`,
      )
      .all(backfill)
      .reverse();
    for (const r of recent) {
      process.stdout.write(rowToJson(r) + "\n");
      cursor = r.rowid;
    }
  }

  if (!follow) {
    db.close();
    return;
  }

  // Establish the cursor at the highest existing rowid so `--backfill 0
  // --follow` only emits truly new rows. Without this we'd re-emit the whole
  // table on the first poll.
  if (cursor === 0) {
    const maxRow = db
      .query<{ rowid: number | null }, []>(
        `SELECT MAX(rowid) AS rowid FROM audit_events`,
      )
      .get();
    cursor = maxRow?.rowid ?? 0;
  }

  const next = db.query<RawRow, [number]>(
    `SELECT ${SELECT_COLS} FROM audit_events WHERE rowid > ? ORDER BY rowid`,
  );

  const cleanup = (): never => {
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  while (true) {
    const rows = next.all(cursor);
    for (const r of rows) {
      process.stdout.write(rowToJson(r) + "\n");
      cursor = r.rowid;
    }
    await Bun.sleep(TAIL_POLL_MS);
  }
}

async function since(args: string[]): Promise<void> {
  const [duration] = args.filter((a) => !a.startsWith("--"));
  if (!duration) {
    process.stderr.write(
      "usage: midplane audit since <duration>  (e.g. 1h, 30m, 7d, 1d12h)\n",
    );
    process.exit(2);
  }
  const ms = parseDuration(duration);
  if (ms === null) {
    process.stderr.write(`midplane audit: invalid duration "${duration}"\n`);
    process.exit(2);
  }
  const cutoff = Date.now() - ms;
  const db = openDb();
  const rows = db
    .query<RawRow, [number]>(
      `SELECT ${SELECT_COLS} FROM audit_events WHERE ts >= ? ORDER BY ts`,
    )
    .all(cutoff);
  for (const r of rows) process.stdout.write(rowToJson(r) + "\n");
  db.close();
}

async function stats(args: string[]): Promise<void> {
  const opts = parseFlags(args, { since: "24h", json: "false" });
  const ms = parseDuration(opts.since);
  if (ms === null) {
    process.stderr.write(`midplane audit: invalid duration "${opts.since}"\n`);
    process.exit(2);
  }
  const cutoff = Date.now() - ms;
  const db = openDb();

  const totals = db
    .query<StatsRow, [number]>(
      `SELECT event_type AS k, COUNT(*) AS n FROM audit_events
       WHERE ts >= ? GROUP BY event_type ORDER BY n DESC`,
    )
    .all(cutoff);

  const denyByRule = db
    .query<StatsRow, [number]>(
      `SELECT json_extract(payload, '$.policy_rule') AS k, COUNT(*) AS n
       FROM audit_events
       WHERE ts >= ?
         AND event_type = 'DECIDED'
         AND json_extract(payload, '$.decision') = 'DENY'
       GROUP BY k ORDER BY n DESC LIMIT 10`,
    )
    .all(cutoff);

  const allowByStmt = db
    .query<StatsRow, [number]>(
      `SELECT json_extract(payload, '$.statement_type') AS k, COUNT(*) AS n
       FROM audit_events
       WHERE ts >= ?
         AND event_type = 'DECIDED'
         AND json_extract(payload, '$.decision') = 'ALLOW'
       GROUP BY k ORDER BY n DESC LIMIT 10`,
    )
    .all(cutoff);

  // Group by agent_name (not agent_version) — version granularity drowns
  // out the top-N. Operators digging into a specific agent can filter
  // further with `audit since` + jq.
  const byAgent = db
    .query<StatsRow, [number]>(
      `SELECT COALESCE(agent_name, '<anon>') AS k, COUNT(DISTINCT query_id) AS n
       FROM audit_events WHERE ts >= ? GROUP BY k ORDER BY n DESC LIMIT 10`,
    )
    .all(cutoff);

  if (opts.json === "true") {
    process.stdout.write(
      JSON.stringify(
        {
          window: opts.since,
          cutoff_ts: cutoff,
          totals,
          deny_by_rule: denyByRule,
          allow_by_statement: allowByStmt,
          by_agent: byAgent,
        },
        null,
        2,
      ) + "\n",
    );
    db.close();
    return;
  }

  const out = process.stdout;
  out.write(`Audit stats — last ${opts.since}\n`);
  out.write(`(events with ts >= ${new Date(cutoff).toISOString()})\n\n`);
  out.write("Events by type:\n");
  printTable(totals);
  out.write("\nDenies by policy rule:\n");
  printTable(denyByRule);
  out.write("\nAllows by statement type:\n");
  printTable(allowByStmt);
  out.write("\nQueries by agent:\n");
  printTable(byAgent);
  db.close();
}

function printTable(rows: StatsRow[]): void {
  if (rows.length === 0) {
    process.stdout.write("  (none)\n");
    return;
  }
  const labels = rows.map((r) => r.k ?? "(null)");
  const w = Math.max(...labels.map((l) => l.length));
  for (let i = 0; i < rows.length; i++) {
    process.stdout.write(`  ${labels[i]!.padEnd(w)}  ${rows[i]!.n}\n`);
  }
}

// "1h", "30m", "7d", "1d12h" → ms. Returns null on any malformed input
// (including zero-total like "0h"). Each token must be N + s|m|h|d, no gaps.
export function parseDuration(s: string): number | null {
  const re = /(\d+)([smhd])/g;
  const units: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  let total = 0;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index !== lastIdx) return null;
    total += Number(m[1]) * units[m[2]!]!;
    lastIdx = re.lastIndex;
  }
  if (lastIdx !== s.length || total === 0) return null;
  return total;
}

function parseFlags(
  args: string[],
  defaults: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...defaults };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--")) continue;
    if (a.startsWith("--no-")) {
      out[a.slice(5)] = "false";
      continue;
    }
    const eq = a.indexOf("=");
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = "true";
    }
  }
  return out;
}

export function printAuditHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`midplane audit — read the local audit log

Usage:
  midplane audit tail [--backfill N] [--no-follow]
      Stream audit events as JSON lines. Default: backfill last 10, follow forever.

  midplane audit since <duration>
      One-shot dump of events with ts within the window.
      Examples: 1h, 30m, 7d, 1d12h.

  midplane audit stats [--since DURATION] [--json]
      Summarize events in the window (default 24h):
      event types, deny rules, allow statement types, top agents.

DB_PATH overrides the default ${DEFAULT_DB_PATH}.
`);
}
