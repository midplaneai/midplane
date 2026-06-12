// `midplane audit` — read the local SQLite audit log without writing SQL.
//
// Five subcommands, all read-only against DB_PATH (default /data/audit.db):
//   tail   — backfill recent rows + poll for new ones
//   since  — one-shot dump of rows newer than a duration window
//   denies — just the denials, each with the SQL that was blocked and why
//   show   — every event for one query_id (the forensic chain)
//   stats  — group-by summary over a window (event types, deny rules, etc.)
//
// Output is pretty (aligned, colored lines) on a TTY and JSON lines when
// piped — render.ts owns the convention; `--json` / `--pretty` override.
//
// We open SQLite directly with `bun:sqlite` rather than going through the
// HTTP /audit/since endpoint because (a) `docker exec` is already inside the
// container, and (b) the HTTP path requires INDEXER_TOKEN, which a self-host
// admin shouldn't need to provision just to read their own log.

import { Database } from "bun:sqlite";
import { SqliteAuditWriter } from "@midplane/engine";
import {
  fmtTs,
  oneLine,
  paletteFor,
  prettyMode,
  renderEventLine,
  stripControl,
  type AuditRowView,
  type Palette,
} from "./render.ts";

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
    case "denies":
      return denies(rest);
    case "show":
      return show(rest);
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

// Forensic tooling must degrade per-row, not crash per-table: one corrupt
// payload (disk damage, partial manual repair, a future writer bug) in a
// million-row audit DB must not take down tail/since/denies/show. The bad
// row surfaces with its raw text instead of being silently skipped.
function parsePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _unparseable_payload: raw.slice(0, 200) };
  }
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
    payload: parsePayload(r.payload),
    schema_version: r.schema_version,
  });
}

function rowToView(r: RawRow): AuditRowView {
  return {
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
    payload: parsePayload(r.payload),
  };
}

// One writer for both output modes, chosen once per invocation rather than
// per row (a tail must not flip format mid-stream if the consumer changes).
function makeEmit(flags: Record<string, string>): (r: RawRow) => void {
  if (!prettyMode(flags)) {
    return (r) => process.stdout.write(rowToJson(r) + "\n");
  }
  const p = paletteFor(true);
  return (r) => process.stdout.write(renderEventLine(rowToView(r), p) + "\n");
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
  const emit = makeEmit(opts);
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
      emit(r);
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
  const maxRowid = db.query<{ m: number | null }, []>(
    `SELECT MAX(rowid) AS m FROM audit_events`,
  );

  const cleanup = (): never => {
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  while (true) {
    // rowid is monotonic for inserts but NOT across deletes: the retention
    // prune (DELETE /audit/before) can empty the table, after which SQLite
    // reuses rowids from 1 — a cursor parked above them would silently skip
    // every new event forever. MAX(rowid) < cursor can ONLY happen when no
    // pre-prune row survived (the prune deletes oldest-first, so any
    // survivor would hold a rowid >= cursor) — everything now in the table
    // is post-prune and unemitted, so restart from 0.
    const top = maxRowid.get()?.m ?? 0;
    if (top < cursor) cursor = 0;
    const rows = next.all(cursor);
    for (const r of rows) {
      emit(r);
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
  const opts = parseFlags(args, {});
  const emit = makeEmit(opts);
  const cutoff = Date.now() - ms;
  const db = openDb();
  // iterate(), not all(): `since 7d` on a busy install can span millions of
  // rows whose payloads carry up-to-1MiB sql_raw — materializing the window
  // before emitting is an OOM, and the output is line-oriented anyway.
  const stmt = db.query<RawRow, [number]>(
    `SELECT ${SELECT_COLS} FROM audit_events WHERE ts >= ? ORDER BY ts`,
  );
  for (const r of stmt.iterate(cutoff)) emit(r);
  db.close();
}

// ── denies ──────────────────────────────────────────────────────────────────

// The question an operator actually asks the log: what got blocked, and why?
// Each denial is a DECIDED row; the SQL that was blocked lives on the
// ATTEMPTED row of the same query_id. A missing ATTEMPTED row (only possible
// if the log was partially pruned) must not hide the denial itself.

const DENIES_LIMIT_DEFAULT = 200;

// Batch size for the ATTEMPTED back-fill IN() list — comfortably under
// SQLite's bound-parameter ceiling.
const ATTEMPTED_FETCH_CHUNK = 500;

async function denies(args: string[]): Promise<void> {
  const opts = parseFlags(args, { since: "24h", limit: String(DENIES_LIMIT_DEFAULT) });
  const ms = parseDuration(opts.since);
  if (ms === null) {
    process.stderr.write(`midplane audit: invalid duration "${opts.since}"\n`);
    process.exit(2);
  }
  const limit = Math.max(1, Number.parseInt(opts.limit ?? "", 10) || DENIES_LIMIT_DEFAULT);
  const cutoff = Date.now() - ms;
  const db = openDb();

  // Two indexed queries instead of one JOIN: SQLite plans the join via
  // idx_audit_type_ts (event_type=ATTEMPTED) and rescans every ATTEMPTED row
  // per denial — measured 170x slower than idx_audit_query_id probes at 200k
  // rows. Fetch the LIMIT-capped denials first (idx_audit_type_ts), then
  // batch-fetch their ATTEMPTED payloads by query_id (idx_audit_query_id).
  // The query keeps the LATEST `limit` denials; the reverse puts oldest
  // first so the newest denial lands at the bottom of the terminal.
  const rows = db
    .query<RawRow, [number, number]>(
      `SELECT ${SELECT_COLS} FROM audit_events
       WHERE ts >= ?
         AND event_type = 'DECIDED'
         AND json_extract(payload, '$.decision') = 'DENY'
       ORDER BY rowid DESC LIMIT ?`,
    )
    .all(cutoff, limit)
    .reverse();

  const attemptedByQuery = new Map<string, string>();
  const qids = [...new Set(rows.map((r) => r.query_id))];
  for (let i = 0; i < qids.length; i += ATTEMPTED_FETCH_CHUNK) {
    const chunk = qids.slice(i, i + ATTEMPTED_FETCH_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const attempted = db
      .query<{ query_id: string; payload: string }, string[]>(
        `SELECT query_id, payload FROM audit_events
         WHERE event_type = 'ATTEMPTED' AND query_id IN (${placeholders})`,
      )
      .all(...chunk);
    for (const a of attempted) attemptedByQuery.set(a.query_id, a.payload);
  }

  const attemptedFor = (r: RawRow): Record<string, unknown> | null => {
    const payload = attemptedByQuery.get(r.query_id);
    return payload ? parsePayload(payload) : null;
  };

  if (!prettyMode(opts)) {
    for (const r of rows) {
      const view = rowToView(r);
      process.stdout.write(
        JSON.stringify({ ...view, sql_raw: attemptedFor(r)?.sql_raw ?? null }) + "\n",
      );
    }
    db.close();
    return;
  }

  const p = paletteFor(true);
  if (rows.length === 0) {
    process.stdout.write(`No denials in the last ${opts.since}.\n`);
    db.close();
    return;
  }
  for (const r of rows) {
    const pl = parsePayload(r.payload);
    writeDenyBlock(p, r, pl, attemptedFor(r));
  }
  process.stdout.write(
    p.dim(
      `${rows.length} denial${rows.length === 1 ? "" : "s"} in the last ${opts.since}` +
        (rows.length === limit ? ` (showing latest ${limit}; raise --limit or narrow --since)` : ""),
    ) + "\n",
  );
  db.close();
}

function writeDenyBlock(
  p: Palette,
  r: RawRow,
  decided: Record<string, unknown>,
  attempted: Record<string, unknown> | null,
): void {
  const out = process.stdout;
  const head: string[] = [p.dim(fmtTs(r.ts)), p.red("DENIED"), p.bold(String(decided.policy_rule ?? "unknown"))];
  if (r.agent_name) head.push(p.dim(`agent=${r.agent_name}`));
  if (r.database !== "__default__") head.push(p.dim(`db=${r.database}`));
  head.push(p.dim(`qid=${r.query_id}`));
  out.write(head.join(" ") + "\n");
  const sql = attempted && typeof attempted.sql_raw === "string" ? attempted.sql_raw : null;
  if (sql) out.write(`  sql:    ${oneLine(sql, 200)}\n`);
  if (typeof decided.reason === "string") {
    out.write(`  reason: ${decided.reason}\n`);
  }
  if (r.agent_intent) out.write(`  intent: ${oneLine(r.agent_intent, 200)}\n`);
  out.write("\n");
}

// ── show ────────────────────────────────────────────────────────────────────

// Forensic view: every event for one query, in order. Accepts a query_id
// (what tail/denies print as qid=...) or, as a courtesy, an individual
// event id — pasting the wrong one of the two should still work.
async function show(args: string[]): Promise<void> {
  const [target] = args.filter((a) => !a.startsWith("--"));
  if (!target) {
    process.stderr.write("usage: midplane audit show <query_id>\n");
    process.exit(2);
  }
  const opts = parseFlags(args, {});
  const db = openDb();

  let rows = db
    .query<RawRow, [string]>(
      `SELECT ${SELECT_COLS} FROM audit_events WHERE query_id = ? ORDER BY rowid`,
    )
    .all(target);
  if (rows.length === 0) {
    const byEventId = db
      .query<{ query_id: string }, [string]>(
        `SELECT query_id FROM audit_events WHERE id = ?`,
      )
      .get(target);
    if (byEventId) {
      rows = db
        .query<RawRow, [string]>(
          `SELECT ${SELECT_COLS} FROM audit_events WHERE query_id = ? ORDER BY rowid`,
        )
        .all(byEventId.query_id);
    }
  }
  if (rows.length === 0) {
    process.stderr.write(`midplane audit: no events for "${target}"\n`);
    db.close();
    process.exit(1);
  }

  if (!prettyMode(opts)) {
    for (const r of rows) process.stdout.write(rowToJson(r) + "\n");
    db.close();
    return;
  }

  const p = paletteFor(true);
  const out = process.stdout;
  const first = rows[0]!;
  out.write(
    `${p.bold(`query ${first.query_id}`)} — ${rows.length} event${rows.length === 1 ? "" : "s"}\n`,
  );
  out.write(`  tenant:  ${first.tenant_id}\n`);
  out.write(`  db:      ${first.database}\n`);
  if (first.agent_name) {
    out.write(
      `  agent:   ${first.agent_name}${first.agent_version ? `@${first.agent_version}` : ""}\n`,
    );
  }
  if (first.agent_intent) out.write(`  intent:  ${oneLine(first.agent_intent, 200)}\n`);
  const attempted = rows.find((r) => r.event_type === "ATTEMPTED");
  if (attempted) {
    const pl = parsePayload(attempted.payload);
    if (typeof pl.sql_raw === "string") {
      // The full statement, indented — this is the one place we don't
      // collapse to a single line (it's the forensic record), but a 1 MiB
      // sql_raw still shouldn't firehose a terminal, and control bytes are
      // stripped (sql_raw is attacker-controlled; ESC sequences would
      // execute on the operator's terminal — newlines/tabs stay).
      const safe = stripControl(pl.sql_raw);
      const sql = safe.length > 10_000 ? safe.slice(0, 10_000) + "\n  … (truncated)" : safe;
      out.write(`  sql:\n${sql.replace(/^/gm, "    ")}\n`);
    }
  }
  out.write("\n");
  for (const r of rows) {
    out.write(renderEventLine(rowToView(r), p) + "\n");
  }
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

// Flags that never take a value. Without this, `audit show --json <qid>`
// would consume the qid as --json's VALUE — the flag silently stops forcing
// JSON and the positional disappears.
const BOOLEAN_FLAGS = new Set(["json", "pretty", "follow"]);

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
    const key = a.slice(2);
    const next = args[i + 1];
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

export function printAuditHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`midplane audit — read the local audit log

Usage:
  midplane audit tail [--backfill N] [--no-follow]
      Stream audit events. Default: backfill last 10, follow forever.

  midplane audit since <duration>
      One-shot dump of events with ts within the window.
      Examples: 1h, 30m, 7d, 1d12h.

  midplane audit denies [--since DURATION] [--limit N]
      Denials only (default window 24h), each with the blocked SQL, the
      rule, the agent-facing reason, and the agent's stated intent.

  midplane audit show <query_id>
      Every event for one query — agent, intent, full SQL, and the
      ATTEMPTED → DECIDED → EXECUTED/FAILED chain. Accepts the qid=...
      printed by tail/denies (an event id also works).

  midplane audit stats [--since DURATION] [--json]
      Summarize events in the window (default 24h):
      event types, deny rules, allow statement types, top agents.

tail/since/denies/show are human-readable on a TTY and JSON lines when
piped; --json and --pretty force one or the other. stats prints its text
summary either way (--json for the machine shape). Color respects NO_COLOR.
DB_PATH overrides the default ${DEFAULT_DB_PATH}.
`);
}
