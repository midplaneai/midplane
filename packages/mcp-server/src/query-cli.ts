// `midplane query` — send ONE statement through a running Midplane server
// exactly as an agent would: the same MCP `query` tool, the same policy
// evaluation, the same audit pipeline, the same agent-facing deny message.
//
// This is a verification harness, not a database client — psql exists. One
// shot, no REPL, no meta-commands, no pager. Three jobs:
//   1. setup verification — "midplane query --sql 'SELECT 1' works, point
//      your agent at it" (doctor reuses this as its end-to-end canary)
//   2. deny reproduction — re-run the exact SQL from `audit show` and see
//      the verdict + message the agent saw, verbatim
//   3. policy spot-checks against the LIVE server (vs `policy test`, which
//      evaluates a file offline)
//
// Identity: clientInfo is midplane-cli@<version>, so these calls stamp
// agent_name="midplane-cli" on their audit rows. CLI traffic is visible and
// filterable in `midplane audit` — never disguised as an agent, and never
// bypassing policy (anyone who can run this already holds the DSN; this
// path is strictly more restricted).
//
// Transport: Streamable HTTP against http://localhost:$PORT/mcp by default
// (the same URL an agent gets). `--stdio` instead spawns a child server on
// stdio — for setups that never run HTTP — inheriting this process's env so
// DATABASE_URL/MIDPLANE_POLICY_FILE resolve exactly as the agent's spawn
// would.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { parseArgs } from "./argv.ts";
import { paletteFor, prettyMode, renderRowsTable } from "./render.ts";
import { ensureHttpScheme } from "./dsn.ts";
import { DEFAULT_PORT } from "./config.ts";
import { version as PACKAGE_VERSION } from "../package.json" with { type: "json" };

// The `query` tool requires intent (it lands on every audit row). A default
// keeps one-off verification ergonomic; anything investigative should say
// why with --intent so the audit log stays meaningful.
const DEFAULT_INTENT = "manual verification query via midplane CLI";

// Pretty output caps the table; a SELECT over a big table shouldn't flood a
// terminal. The full result is always available via --json.
const MAX_PRETTY_ROWS = 100;

export interface McpQueryTarget {
  // Exactly one of the two. serverUrl points at a running HTTP server's /mcp
  // endpoint; stdio spawns a child `midplane server` with this process's env.
  serverUrl?: string;
  stdio?: boolean;
}

// Decoded body of the query tool's text content. Allowed and denied shapes
// share the envelope (tools/query.ts owns the contract).
export interface McpQueryResult {
  allowed: boolean;
  rows?: Array<Record<string, unknown>>;
  rowCount?: number;
  policy_rule?: string;
  reason?: string;
  auditId?: string;
}

// One MCP session, one tool call, close. Exported for doctor's canary.
export async function mcpQuery(
  target: McpQueryTarget,
  args: { sql: string; intent: string; database?: string },
): Promise<McpQueryResult> {
  const client = new Client({ name: "midplane-cli", version: PACKAGE_VERSION });
  const transport = target.stdio
    ? new StdioClientTransport({
        // Same entrypoint the container wrapper execs; process.execPath is
        // the running bun. Full env passes through (the SDK's default env
        // allowlist would drop DATABASE_URL) — EXCEPT LOG_LEVEL, which is
        // forced silent unconditionally: pino writes to stdout, and stdout
        // is the MCP channel here. An inherited LOG_LEVEL=info would
        // corrupt the JSON-RPC stream.
        command: process.execPath,
        args: [join(import.meta.dir, "cli.ts"), "server"],
        env: {
          ...cleanEnv(),
          MIDPLANE_TRANSPORT: "stdio",
          LOG_LEVEL: "silent",
        },
      })
    : new StreamableHTTPClientTransport(new URL(target.serverUrl!));
  await client.connect(transport);
  try {
    const res = await client.callTool({
      name: "query",
      arguments: {
        sql: args.sql,
        intent: args.intent,
        ...(args.database ? { database: args.database } : {}),
      },
    });
    const content = res.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.[0]?.text;
    if (typeof text !== "string") {
      throw new Error("server returned no tool content (unexpected response shape)");
    }
    let parsed: McpQueryResult;
    try {
      parsed = JSON.parse(text) as McpQueryResult;
    } catch {
      throw new Error("server returned malformed tool content (not JSON) — version mismatch?");
    }
    // `allowed` drives the ALLOW/DENY branch and the exit code; a
    // version-skewed server sending `"allowed": "false"` (truthy!) must not
    // be misread as an ALLOW.
    if (typeof parsed.allowed !== "boolean") {
      throw new Error("server returned an unexpected result shape (no boolean `allowed`) — version mismatch?");
    }
    return parsed;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runQuery(argv: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  if (flags.help === "true" || positionals[0] === "help") {
    printQueryHelp();
    return;
  }
  // `--sql "<query>"` mirrors `policy test`; a bare positional also works
  // (`midplane query "SELECT 1"`). Multiple positionals re-join so unquoted
  // simple statements don't confuse anyone.
  const sql = flags.sql ?? (positionals.length > 0 ? positionals.join(" ") : undefined);
  if (!sql) {
    process.stderr.write(
      'usage: midplane query --sql "<query>" [--intent "<why>"] [--server URL | --stdio] [--database <name>] [--json]\n',
    );
    process.exit(2);
  }
  const stdio = flags.stdio === "true";
  let serverUrl: string | undefined;
  if (!stdio) {
    // An unparseable --server is a usage error (exit 2), not a stack trace.
    try {
      serverUrl = normalizeServerUrl(flags.server);
    } catch {
      process.stderr.write(`midplane query: invalid --server URL "${flags.server}"\n`);
      process.exit(2);
    }
  }
  const target: McpQueryTarget = stdio ? { stdio: true } : { serverUrl };

  let result: McpQueryResult;
  try {
    result = await mcpQuery(target, {
      sql,
      intent: flags.intent ?? DEFAULT_INTENT,
      database: flags.database ?? flags.db,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // Connection-refused wording differs across runtimes (node: "fetch
    // failed"/ECONNREFUSED, bun: "Unable to connect..."); match all of them.
    if (!stdio && /fetch failed|ECONNREFUSED|ConnectionRefused|Unable to connect/i.test(msg)) {
      process.stderr.write(
        `midplane query: cannot reach ${serverUrl} — is the server running? (\`midplane doctor\` checks this)\n`,
      );
    } else {
      process.stderr.write(`midplane query: ${msg}\n`);
    }
    process.exit(1);
  }

  if (!prettyMode(flags)) {
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.allowed ? 0 : 1);
  }

  const p = paletteFor(true);
  const out = process.stdout;
  if (result.allowed) {
    out.write(p.green(p.bold("ALLOW")) + "\n");
    const rows = result.rows ?? [];
    const shown = rows.slice(0, MAX_PRETTY_ROWS);
    for (const line of renderRowsTable(shown, p)) out.write(line + "\n");
    if (rows.length > shown.length) {
      out.write(p.dim(`… ${rows.length - shown.length} more rows (use --json for all)\n`));
    }
    out.write(
      p.dim(`${result.rowCount ?? rows.length} row${(result.rowCount ?? rows.length) === 1 ? "" : "s"}  audit=${result.auditId ?? "?"}\n`),
    );
    return;
  }

  out.write(p.red(p.bold("DENY")) + "\n");
  out.write(`  rule:    ${result.policy_rule ?? "unknown"}\n`);
  // The reason is the exact sentence the agent reads on a denial — show it
  // verbatim, that message IS the product's deny UX.
  out.write(`  message: ${result.reason ?? "(none)"}\n`);
  out.write(p.dim(`  audit:   ${result.auditId ?? "?"}\n`));
  out.write("  → blocked; the query never reached the database\n");
  process.exit(1);
}

// Accept a bare host:port or a server root and route to /mcp; a full URL
// with an explicit path passes through untouched. A bare `--server` flag
// (parsed as "true") means "the default". Throws on unparseable input — the
// caller turns that into a usage error.
export function normalizeServerUrl(raw: string | undefined): string {
  const fallback = `http://localhost:${process.env.PORT ?? DEFAULT_PORT}/mcp`;
  if (!raw || raw === "true") return fallback;
  const url = new URL(ensureHttpScheme(raw));
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/mcp";
  return url.toString();
}

// StdioClientTransport's env type rejects undefined values; process.env
// allows them.
function cleanEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function printQueryHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`midplane query — send one query through Midplane exactly as an agent would

Same MCP tool, same policy, same audit trail (agent_name=midplane-cli),
same deny message. A verification harness, not a database client.

Usage:
  midplane query --sql "<query>" [options]
  midplane query "<query>" [options]

Options:
  --sql "<query>"      The statement to send (or pass it as the positional).
  --intent "<why>"     Audit intent for the call (default: "${DEFAULT_INTENT}").
  --server <url>       Server to call (default http://localhost:\$PORT/mcp,
                       port 8080 when PORT is unset). Bare host:port works.
  --stdio              Spawn a child \`midplane server\` over stdio instead of
                       HTTP — for stdio-transport setups. Uses this shell's
                       env (DATABASE_URL, MIDPLANE_POLICY_FILE, ...).
  --database <name>    Target database on a multi-DB server.
  --json               Print the raw result JSON (default when piped).

Exit codes: 0 allowed, 1 denied or error, 2 usage.

Examples:
  midplane query --sql "SELECT 1"
  midplane query --sql "DELETE FROM users" --intent "verify the policy blocks this"
  midplane audit denies        # find a qid, then reproduce:
  midplane audit show <qid>    # copy the SQL and re-run it here
`);
}
