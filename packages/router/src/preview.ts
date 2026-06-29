// Cloud → engine masked preview: real execution behind the dashboard's
// "masked preview" surface (design D2 / eng-review E1).
//
//   acquire ──► MCP query tool ──► masked rows | structured rejection
//      │              │                     │
//   spawn-on-     the SAME tool the     engine.handle() executed +
//   demand        agent calls           maskResultSet applied
//
// Unlike the dry-run path (which stops at engine.decide() — parse + policy, no
// execution), this drives the actual `query` MCP tool against the spawned
// container. That tool runs the full pipeline (parse → policy → audit →
// execute → MASK), so the rows it returns are byte-identical to what a real
// agent receives — the only way to *prove* masking. There is no second
// decision/execution brain here: we are the agent.
//
// Why MCP (not a new /admin endpoint): the engine masking ships in the pinned
// image and is enforced only on the handle() path. Reusing the registry + the
// agent's own tool keeps this purely cloud-side (no engine change, no image
// pin bump) and guarantees the preview can't drift from enforcement.
//
// Freshness: acquire() spawns from SpawnOptions read at request time, so a cold
// spawn is current by construction; warm containers are kept current by the
// edit paths (table_access/guardrails hot-reload via pushPolicy, column_masks
// force a respawn — masks are boot-time, see applyPolicyConfigChange). So no
// pushPolicy is needed here.
//
// Blast radius: the caller (the cloud route) gates this owner/admin-only,
// rate-limits it, and validates the SQL is a single read-only SELECT before we
// ever acquire. We additionally cap the rows handed back (the engine still
// executes the whole statement — there is no LIMIT injection).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { safeErrorDetail } from "./db-error.ts";
import type { ContainerRegistry, SpawnOptions } from "./spawner.ts";

export interface PreviewRequest {
  /** Agent-facing DB alias to target. Only sent to the tool when the project
   *  has >1 DB (the engine's single-DB `query` surface takes no `database`). */
  database: string;
  /** The statement to run. Validated read-only single SELECT by the caller. */
  sql: string;
  /** Free-text intent stamped on the audit rows (so a preview run is legible
   *  as a console action, not an agent query). */
  intent: string;
  /** Max rows handed back to the caller. The engine executes the full query;
   *  this only bounds the payload that leaves the engine boundary. */
  rowLimit: number;
}

export type PreviewOutcome =
  // The engine ALLOWED + executed the statement; `rows` are the agent's-eye
  // (masked) values. `truncated` is set when the caller's rowLimit clipped them.
  | {
      ok: true;
      kind: "rows";
      rows: Array<Record<string, unknown>>;
      rowCount: number | null;
      truncated: boolean;
      auditId: string | null;
    }
  // The engine DENIED (a normal Decision, including the fail-closed
  // `column_masking` reject). `policyRule` is the wire rule name
  // (e.g. "column_masking", "table_access", "tenant_scope_missing"); `reason`
  // is the polished agent-facing sentence (carries the reason + the hint).
  | { ok: true; kind: "rejected"; policyRule: string; reason: string; auditId: string | null }
  // Spawn failed, the MCP handshake/tool call failed/timed out, or the engine
  // returned an unparseable body. Retryable from the UI.
  | { ok: false; kind: "engine_unavailable"; detail?: string };

/** The first text-content block of a `query` tool result + its isError flag —
 *  the minimal surface `parseQueryToolResult` needs. The default driver fills
 *  this from the SDK CallToolResult; tests stub it directly. */
export interface RawToolResult {
  text: string;
  isError: boolean;
}

export interface CallQueryToolArgs {
  url: string;
  /** Present only for the multi-DB tool surface. */
  database: string | undefined;
  sql: string;
  intent: string;
  timeoutMs: number;
}

export interface PreviewDeps {
  registry: ContainerRegistry;
  /** Whole-operation budget: cold spawn (already paid by acquire) + one MCP
   *  handshake + one tool call. Default 60s. */
  timeoutMs?: number;
  /** Injectable MCP driver. Defaults to the SDK streamable-HTTP client; tests
   *  pass a stub so previewQuery is exercisable without a live engine. */
  callQueryTool?: (args: CallQueryToolArgs) => Promise<RawToolResult>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

// Client identity the engine records as `agent_name` on every audit row this
// preview emits — so a preview run reads as a console action in the audit log,
// distinct from a real agent. (Pairs with the route's `intent`.)
const PREVIEW_CLIENT_NAME = "midplane-console-preview";
const PREVIEW_CLIENT_VERSION = "1.0.0";

export async function previewQuery(
  spawn: SpawnOptions,
  req: PreviewRequest,
  deps: PreviewDeps,
): Promise<PreviewOutcome> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 1. acquire — spawn-on-demand. A fresh spawn reads policy + masks from its
  //    SpawnOptions, so it's current by construction.
  let active: { host: string; port: number };
  try {
    active = await deps.registry.acquire(spawn);
  } catch (err) {
    return { ok: false, kind: "engine_unavailable", detail: message(err) };
  }

  // 2. drive the agent's `query` tool. `database` is sent only when the project
  //    has >1 DB — the single-DB tool surface rejects an unexpected arg.
  const url = `http://${active.host}:${active.port}/mcp`;
  const database = spawn.databases.length > 1 ? req.database : undefined;
  const call = deps.callQueryTool ?? defaultCallQueryTool;

  let raw: RawToolResult;
  try {
    raw = await call({
      url,
      database,
      sql: req.sql,
      intent: req.intent,
      timeoutMs,
    });
  } catch (err) {
    // Container died after acquire, a transport-level MCP error (e.g. audit
    // unavailable bubbled up), or the call timed out → respawn next time.
    await deps.registry.invalidate(spawn.projectId).catch(() => undefined);
    return { ok: false, kind: "engine_unavailable", detail: message(err) };
  }

  // 3. parse the tool result into a typed outcome.
  return parseQueryToolResult(raw, req.rowLimit);
}

/** Pure mapping from the `query` tool's JSON content → PreviewOutcome. Split out
 *  so the success / rejection / malformed branches are unit-testable without an
 *  engine. The tool's contract (engine/.../tools/query.ts):
 *    ALLOW  → { allowed: true,  rows, rowCount, auditId }
 *    DENY   → { allowed: false, policy_rule, reason, auditId }  (isError: true)
 *  A `column_masking` reject is just the DENY shape with that policy_rule. */
export function parseQueryToolResult(
  raw: RawToolResult,
  rowLimit: number,
): PreviewOutcome {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw.text) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      kind: "engine_unavailable",
      detail: "engine returned an unparseable response",
    };
  }

  if (data.allowed === true) {
    const allRows = Array.isArray(data.rows)
      ? (data.rows as Array<Record<string, unknown>>)
      : [];
    const limit = Math.max(0, rowLimit);
    const rows = allRows.slice(0, limit);
    return {
      ok: true,
      kind: "rows",
      rows,
      rowCount: typeof data.rowCount === "number" ? data.rowCount : null,
      truncated: allRows.length > rows.length,
      auditId: typeof data.auditId === "string" ? data.auditId : null,
    };
  }

  if (data.allowed === false) {
    return {
      ok: true,
      kind: "rejected",
      policyRule:
        typeof data.policy_rule === "string" ? data.policy_rule : "unknown",
      reason:
        typeof data.reason === "string" && data.reason.length > 0
          ? data.reason
          : "The engine denied this query.",
      auditId: typeof data.auditId === "string" ? data.auditId : null,
    };
  }

  // Neither shape — a contract drift or a non-query content block.
  return {
    ok: false,
    kind: "engine_unavailable",
    detail: "engine returned an unexpected response shape",
  };
}

// Default MCP driver: a one-shot streamable-HTTP client that connects (which
// performs the initialize handshake), calls `query`, and closes. The SDK owns
// session lifecycle + SSE parsing, so this stays a thin wrapper.
async function defaultCallQueryTool(
  args: CallQueryToolArgs,
): Promise<RawToolResult> {
  const client = new Client({
    name: PREVIEW_CLIENT_NAME,
    version: PREVIEW_CLIENT_VERSION,
  });
  const transport = new StreamableHTTPClientTransport(new URL(args.url));
  try {
    await client.connect(transport);
    const res = await client.callTool(
      {
        name: "query",
        arguments: {
          ...(args.database !== undefined ? { database: args.database } : {}),
          sql: args.sql,
          intent: args.intent,
        },
      },
      undefined,
      { timeout: args.timeoutMs },
    );
    const text =
      (res.content as Array<{ type?: string; text?: string }> | undefined)?.find(
        (c) => c.type === "text",
      )?.text ?? "{}";
    return { text, isError: res.isError === true };
  } finally {
    // Close both so the per-session transport on the engine is torn down and we
    // don't leak sockets across previews.
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

// See dry-run.ts: driver/network errors collapse to an opaque class so DB host
// or schema identifiers never ride out in `detail`; curated app messages pass
// through.
function message(err: unknown): string {
  return safeErrorDetail(err);
}
