// HTTP approval gate — asks the control plane whether a held write may run.
//
// Mirrors the MIDPLANE_DENY_WEBHOOK pair in deny-webhook.ts: URL + bearer token,
// read from env, validated at boot. Unlike that webhook, this one is ON the
// request path — the engine cannot execute until it answers — so its failure
// semantics are the whole design:
//
//   • Any failure to GET AN ANSWER (network, 5xx, timeout, malformed body)
//     raises ApprovalUnavailableError. It is never a denial. A denial fires the
//     deny-webhook and lands in a compliance export as a refusal a human made;
//     a control-plane outage is neither of those things.
//
//   • A timeout is safe to treat as unavailable even though the control plane
//     may already have created the request. The grant is keyed on the statement,
//     so the agent's retry finds that same pending request rather than opening a
//     second one.
//
// The remote is expected to hold the connection briefly (it long-polls for a
// decision) and then answer `pending`. This engine's own deadline sits just past
// that window so a well-behaved control plane always answers first.

import type {
  ApprovalGate,
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalStatus,
} from "@midplane/engine";
import { ApprovalUnavailableError } from "@midplane/engine";
import { logger } from "./logger.ts";

// How long the engine waits for the control plane before calling it unavailable.
//
// The control plane holds ~20s. MCP clients time out at ~60s
// (DEFAULT_REQUEST_TIMEOUT_MSEC in the TypeScript SDK), and the tool call has
// already spent time on parse + policy + the ATTEMPTED audit write. 25s leaves
// the remote room to answer first while keeping the whole call comfortably
// inside every client's budget — which is why this design needs no MCP progress
// notifications at all.
const REQUEST_TIMEOUT_MS = 25_000;

const USER_AGENT = "midplane-approval-gate/1";

export interface ApprovalGateConfig {
  url: string;
  token: string;
}

/** Read + validate the gate config.
 *
 *  Both variables are required TOGETHER. Half-configured is a boot failure, not
 *  a runtime one: an engine that started with a URL and no token would 401 on
 *  every held write, which reaches the operator as "approvals are broken" long
 *  after deploy instead of "approvals are misconfigured" at deploy. Returns null
 *  when neither is set — approvals simply aren't wired. */
export function loadApprovalGateConfig(
  env: NodeJS.ProcessEnv,
): ApprovalGateConfig | null {
  const url = env.MIDPLANE_APPROVAL_URL?.trim();
  const token = env.MIDPLANE_APPROVAL_TOKEN?.trim();

  if (!url && !token) return null;
  if (!url || !token) {
    throw new Error(
      "MIDPLANE_APPROVAL_URL and MIDPLANE_APPROVAL_TOKEN must be set together " +
        `(got ${url ? "URL without token" : "token without URL"}). Refusing to boot — ` +
        "a half-configured gate would fail every held write at query time.",
    );
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("MIDPLANE_APPROVAL_URL must be an http:// or https:// URL");
  }
  return { url, token };
}

export class HttpApprovalGate implements ApprovalGate {
  constructor(
    private readonly config: ApprovalGateConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);

    let res: Response;
    try {
      res = await this.fetchImpl(this.config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.token}`,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify(toWire(req)),
        signal: controller.signal,
      });
    } catch (err) {
      // Includes the timeout. Safe to retry: the grant is statement-keyed, so a
      // request the control plane already created is found by the next attempt.
      throw new ApprovalUnavailableError(
        `approval gate unreachable: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!res.ok) {
      throw new ApprovalUnavailableError(
        `approval gate returned HTTP ${res.status}`,
      );
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new ApprovalUnavailableError("approval gate returned a non-JSON body", err);
    }

    const outcome = parseOutcome(body);
    if (!outcome) {
      // A shape we don't understand is an unknown answer, and an unknown answer
      // is not permission. Fail closed as unavailable rather than guessing.
      logger.error("approval gate returned an unrecognized body shape");
      throw new ApprovalUnavailableError(
        "approval gate returned an unrecognized response",
      );
    }
    return outcome;
  }

  /** Read-only status. One round trip, no hold — this exists precisely so an
   *  agent can ask "any news?" without paying the gate's 20s wait or risking
   *  its single-use grant. */
  async check(
    approvalId: string,
    mcpTokenId: string | null,
    signal?: AbortSignal,
  ): Promise<ApprovalStatus> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.url}/status`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.token}`,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({ approval_id: approvalId, mcp_token_id: mcpTokenId }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new ApprovalUnavailableError(
        `approval status unreachable: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!res.ok) {
      throw new ApprovalUnavailableError(`approval status returned HTTP ${res.status}`);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new ApprovalUnavailableError("approval status returned a non-JSON body", err);
    }

    const parsed = parseStatus(body);
    if (!parsed) {
      throw new ApprovalUnavailableError("approval status returned an unrecognized response");
    }
    return parsed;
  }
}

// Wire shape. Deliberately explicit rather than spreading the request object:
// the gate posts across a trust boundary, so what leaves the engine should be a
// list someone can read, not whatever fields the internal type grows later.
function toWire(req: ApprovalRequest): Record<string, unknown> {
  return {
    query_id: req.queryId,
    database: req.database,
    sql: req.sql,
    intent: req.intent,
    statement_type: req.statementType,
    tables_touched: req.tablesTouched,
    tenant_id: req.tenantId,
    agent_name: req.agentName,
    agent_version: req.agentVersion,
    mcp_token_id: req.mcpTokenId,
  };
}

function parseOutcome(body: unknown): ApprovalOutcome | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

  switch (b.status) {
    case "approved":
      return { status: "approved", by: str(b.by), note: str(b.note) };
    case "denied":
      return { status: "denied", by: str(b.by), note: str(b.note) };
    case "expired":
      return { status: "expired" };
    case "pending": {
      const approvalId = str(b.approval_id);
      const expiresAt = typeof b.expires_at === "number" ? b.expires_at : null;
      // Without an id and a deadline the agent has nothing to come back to, so
      // an incomplete `pending` is as unusable as an unknown status.
      if (!approvalId || expiresAt === null) return null;
      const reviewUrl = str(b.review_url);
      return {
        status: "pending",
        approvalId,
        expiresAt,
        ...(reviewUrl ? { reviewUrl } : {}),
      };
    }
    default:
      return null;
  }
}

// A status check is a cheap read, so it gets a much shorter leash than the gate
// itself — an agent polling should fail fast, not sit on a socket.
const STATUS_TIMEOUT_MS = 8_000;

function parseStatus(body: unknown): ApprovalStatus | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

  switch (b.status) {
    case "approved":
      return { status: "approved", by: str(b.by), note: str(b.note) };
    case "denied":
      return { status: "denied", by: str(b.by), note: str(b.note) };
    case "executed":
      return { status: "executed" };
    case "consumed":
      return { status: "consumed" };
    case "expired":
      return { status: "expired" };
    case "not_found":
      return { status: "not_found" };
    case "pending": {
      const expiresAt = typeof b.expires_at === "number" ? b.expires_at : null;
      if (expiresAt === null) return null;
      return { status: "pending", expiresAt };
    }
    default:
      return null;
  }
}
