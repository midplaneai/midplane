// Write approvals — the control-plane half of the gate.
//
// See docs/designs/write-approvals-mlp.md. This module owns three things:
//
//   1. The GRANT KEY, which binds an approval to one exact statement.
//   2. create-or-find, so an agent that re-runs a held statement lands on its
//      own pending request instead of opening a second one.
//   3. The single-use CLAIM, so two retries racing one approval yield exactly
//      one execution.
//
// It deliberately does NOT own notification (fire-and-forget, off this path) or
// the HTTP surface (route handler).

import { createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { ulid } from "ulid";

import {
  auditEventsIndex,
  getDb,
  writeApprovals,
  type Region,
  type WriteApproval,
} from "@midplane-cloud/db";
import { user } from "@midplane-cloud/db/auth-schema";

/** How long the endpoint holds the connection before answering `pending`.
 *
 *  Sits under the engine's own 25s deadline, which sits under the MCP client's
 *  ~60s timeout. Keeping all three ordered is what lets this design skip MCP
 *  progress notifications entirely: a fast approval returns inside the first
 *  call, and a slow one degrades to a ticket well before anything times out. */
export const HOLD_WINDOW_MS = 20_000;

/** How often the hold re-checks for a decision. Short enough that a human
 *  clicking approve sees the agent continue almost immediately; long enough
 *  that a held write is ~40 cheap indexed reads, not a spin. */
const POLL_INTERVAL_MS = 500;

export interface ApprovalRequestInput {
  customerId: string;
  projectId: string;
  projectDatabaseId: string;
  region: Region;
  queryId: string;
  sql: string;
  intent: string;
  statementType: string;
  tablesTouched: string[];
  agentName: string | null;
  mcpTokenId: string | null;
  expiresAfterSeconds: number;
}

export type GateAnswer =
  | { status: "approved"; by: string | null; note: string | null }
  | { status: "denied"; by: string | null; note: string | null }
  | { status: "expired" }
  | { status: "pending"; approvalId: string; expiresAt: number };

/** Digest binding a grant to one exact statement, for one agent, on one database.
 *
 *  Includes `mcpTokenId` so an approval granted to one agent cannot be collected
 *  by a different agent that happens to run the same SQL — the safer reading, at
 *  the cost of two sessions each needing their own approval for an identical
 *  statement.
 *
 *  `sql` and `intent` go in RAW, not normalized. Normalizing would make
 *  `WHERE id < 100` and `WHERE id < 100000` collide if the normalizer ever
 *  parameterized literals, which is exactly the substitution this key exists to
 *  prevent. Byte-identical or it is a different request.
 *
 *  Length-prefixed so no combination of field contents can be reinterpreted as a
 *  different combination (`a|b` vs `a` + `|b`). */
export function grantKeyFor(input: {
  projectDatabaseId: string;
  sql: string;
  intent: string;
  mcpTokenId: string | null;
}): string {
  const h = createHash("sha256");
  for (const part of [
    input.projectDatabaseId,
    input.sql,
    input.intent,
    input.mcpTokenId ?? "",
  ]) {
    h.update(String(Buffer.byteLength(part, "utf8")));
    h.update(":");
    h.update(part, "utf8");
    h.update("|");
  }
  return h.digest("hex");
}

/** Resolve a held write: claim an existing grant, or open a request and hold.
 *
 *  The order matters. We look for a settled decision FIRST so an agent retrying
 *  after a human acted gets its answer immediately rather than waiting out
 *  another hold window. */
export async function resolveApproval(
  input: ApprovalRequestInput,
  opts: {
    now?: () => number;
    holdMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Called exactly once, when a NEW pending request is opened — never on a
     *  retry that found an existing one. This is the notification guard: an
     *  agent re-running every 30s must not email the approver every 30s. */
    onCreated?: (approval: WriteApproval) => void;
  } = {},
): Promise<GateAnswer> {
  const now = opts.now ?? Date.now;
  const holdMs = opts.holdMs ?? HOLD_WINDOW_MS;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const grantKey = grantKeyFor(input);

  // Settle-or-open, then poll. `settled` covers the retry-after-decision path;
  // when nothing is settled we ensure a pending row exists and wait on it.
  const existing = await claimSettled(
    input.region,
    input.projectDatabaseId,
    grantKey,
    now,
    input.queryId,
  );
  if (existing) return existing;

  const { row: pending, created } = await openRequest(input, grantKey, now);
  if (created) opts.onCreated?.(pending);

  const deadline = now() + holdMs;
  while (now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const settled = await claimSettled(
      input.region,
      input.projectDatabaseId,
      grantKey,
      now,
      input.queryId,
    );
    if (settled) return settled;
  }

  return {
    status: "pending",
    approvalId: pending.id,
    expiresAt: pending.expiresAt.getTime(),
  };
}

/** Look for a settled grant for this statement and consume it if usable.
 *
 *  Three outcomes, and the difference between them is the whole point:
 *
 *  APPROVED is claimed on use. The claim is a conditional UPDATE, not a
 *  read-then-write: `claimed_at IS NULL` lives in the WHERE clause, so two
 *  concurrent retries race inside Postgres and exactly one row comes back.
 *
 *  DENIED persists. A human refused THIS statement, so re-running it identically
 *  keeps being refused — and, importantly, does NOT re-page the approver. The
 *  agent's way forward is a different statement, which is a different grant key.
 *
 *  EXPIRED is reported ONCE and then consumed. Nobody decided it, so "re-run it
 *  to ask again" has to actually work; if an expired row kept answering, that
 *  message would be a lie and the statement would be permanently unaskable. The
 *  first retry after the deadline learns why it failed, and the next one opens a
 *  fresh request. Consuming is atomic, so concurrent retries don't each report
 *  it and then all fall through to opening duplicate requests. */
async function claimSettled(
  region: Region,
  projectDatabaseId: string,
  grantKey: string,
  now: () => number,
  /** The attempt doing the claiming. Stamped on the row so the approval can be
   *  joined to the execution it authorized — the held attempt's own query_id
   *  never executes, so it cannot serve that purpose. */
  claimingQueryId?: string,
): Promise<GateAnswer | null> {
  const db = getDb(region);
  const at = new Date(now());
  const forThisStatement = and(
    eq(writeApprovals.projectDatabaseId, projectDatabaseId),
    eq(writeApprovals.grantKey, grantKey),
  );

  const claimed = await db
    .update(writeApprovals)
    .set({ claimedAt: at, claimedQueryId: claimingQueryId ?? null })
    .where(
      and(
        forThisStatement,
        eq(writeApprovals.status, "approved"),
        isNull(writeApprovals.claimedAt),
        // An approval that outlived its window is not usable. Checked here as
        // well as by the sweeper so a lagging sweep can never widen the window.
        //
        // gt(), not sql`... > ${at}`: a bare Date interpolated into a drizzle
        // template reaches postgres.js unencoded and throws under prepare:false
        // ("Received an instance of Date"). The helper encodes against the
        // column's type instead.
        gt(writeApprovals.expiresAt, at),
      ),
    )
    .returning();

  if (claimed.length > 0) {
    const row = claimed[0]!;
    return {
      status: "approved",
      by: await displayName(region, row.decidedByUserId),
      note: row.decisionNote,
    };
  }

  // Whatever happened most recently to this statement governs.
  const settled = await db
    .select()
    .from(writeApprovals)
    .where(forThisStatement)
    .orderBy(desc(writeApprovals.createdAt))
    .limit(1);

  const row = settled[0];
  if (!row) return null;

  if (row.status === "denied") {
    return {
      status: "denied",
      by: await displayName(region, row.decidedByUserId),
      note: row.decisionNote,
    };
  }

  // Expired, or pending past its deadline (which reads as expired even before
  // the sweeper relabels it — the agent must never be told to keep waiting on a
  // request no human can act on any more). Consume it so the NEXT attempt opens
  // a fresh request instead of hitting this same wall forever.
  const stale =
    row.status === "expired" ||
    (row.status === "pending" && row.expiresAt.getTime() <= now());
  if (!stale) return null;

  const consumed = await db
    .update(writeApprovals)
    .set({ status: "expired", claimedAt: at })
    .where(and(eq(writeApprovals.id, row.id), isNull(writeApprovals.claimedAt)))
    .returning({ id: writeApprovals.id });

  // Lost the race to another retry, which already reported the expiry. Fall
  // through to opening a new request rather than reporting it twice.
  return consumed.length > 0 ? { status: "expired" } : null;
}

/** Resolve a decider to something a human recognises.
 *
 *  This value is handed to the ENGINE and ends up in the agent's output —
 *  "Denied by 01J8ZQ…" tells the developer reading it nothing, and the whole
 *  point of a denial message is that it is actionable. Falls back to the raw id
 *  only if the account row is gone, and to null if there was no decider. */
async function displayName(
  region: Region,
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  try {
    const rows = await getDb(region)
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const row = rows[0];
    return row?.name?.trim() || row?.email?.trim() || userId;
  } catch {
    // Identity lookup must never fail a decision that has already been made.
    return userId;
  }
}

/** Ensure a pending row exists for this statement, and return it.
 *
 *  Races are resolved by the partial unique index rather than by checking first:
 *  two engines asking simultaneously both attempt the insert, one wins, and the
 *  loser reads the winner's row. `onConflictDoNothing` makes that a single
 *  round trip in the common case. */
async function openRequest(
  input: ApprovalRequestInput,
  grantKey: string,
  now: () => number,
): Promise<{ row: WriteApproval; created: boolean }> {
  const db = getDb(input.region);
  const expiresAt = new Date(now() + input.expiresAfterSeconds * 1000);

  const inserted = await db
    .insert(writeApprovals)
    .values({
      id: ulid(),
      customerId: input.customerId,
      projectId: input.projectId,
      projectDatabaseId: input.projectDatabaseId,
      region: input.region,
      grantKey,
      sqlText: input.sql,
      intent: input.intent,
      statementType: input.statementType,
      tablesTouched: input.tablesTouched,
      queryId: input.queryId,
      agentName: input.agentName,
      mcpTokenId: input.mcpTokenId,
      status: "pending",
      expiresAt,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) return { row: inserted[0]!, created: true };

  const existing = await db
    .select()
    .from(writeApprovals)
    .where(
      and(
        eq(writeApprovals.projectDatabaseId, input.projectDatabaseId),
        eq(writeApprovals.grantKey, grantKey),
        eq(writeApprovals.status, "pending"),
      ),
    )
    .limit(1);

  const row = existing[0];
  if (!row) {
    // The pending row vanished between our insert losing and this read — it was
    // decided in that window. Surfacing it as a conflict lets the caller retry
    // and pick up the decision rather than inventing an answer.
    throw new ApprovalRaceError("pending approval settled during creation");
  }
  // Someone else's insert won the race — they own the notification.
  return { row, created: false };
}

export class ApprovalRaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRaceError";
  }
}

/** Relabel pending requests whose window has closed.
 *
 *  Expiry denies, always — a request that times out into a `yes` would be a
 *  denial-of-attention attack on the control plane. Idempotent, so it is safe to
 *  run from a sweeper on any cadence. */
export async function expireStaleApprovals(
  region: Region,
  opts: { now?: () => number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now;
  const db = getDb(region);
  const expired = await db
    .update(writeApprovals)
    .set({ status: "expired", decidedAt: new Date(now()) })
    .where(
      and(
        eq(writeApprovals.status, "pending"),
        lt(writeApprovals.expiresAt, new Date(now())),
      ),
    )
    .returning({ id: writeApprovals.id });
  return expired.length;
}

/** Read-only status of one approval, for the agent's `check_approval` tool.
 *
 *  Deliberately NOT resolveApproval: this must never claim a grant. An agent
 *  asking "any news?" has not committed to executing, and consuming the
 *  single-use approval on a status poll would burn it — the agent would then
 *  re-run and open a fresh request, having lost the approval it was told about.
 *
 *  Scoped to the token that opened the request, not just the project. The engine
 *  authenticates with a per-PROJECT secret, so without this check any agent on
 *  the project could enumerate every other agent's requests by id. Same
 *  reasoning that put mcpTokenId in the grant key.
 *
 *  A mismatched token reads as absent rather than forbidden — never confirm that
 *  an id someone else owns exists. */
export async function checkApprovalStatus(args: {
  region: Region;
  projectId: string;
  approvalId: string;
  mcpTokenId: string | null;
}): Promise<
  | { status: "pending"; expiresAt: number }
  | { status: "approved"; by: string | null; note: string | null }
  | { status: "executed" }
  | { status: "consumed" }
  | { status: "denied"; by: string | null; note: string | null }
  | { status: "expired" }
  | { status: "not_found" }
> {
  const rows = await getDb(args.region)
    .select()
    .from(writeApprovals)
    .where(
      and(
        eq(writeApprovals.id, args.approvalId),
        eq(writeApprovals.projectId, args.projectId),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { status: "not_found" };
  // Scoped to the token that opened the request. A strict !== compares null to
  // null correctly, which matters: stdio and self-host sessions carry no MCP
  // token, and their approval rows store null too. Rejecting on falsiness made
  // check_approval return not_found for every one of those sessions while the
  // pending response was actively telling them to call it. Isolation for
  // tokenless callers is the project, which is already what the grant key gives
  // them — a tokenless session cannot see a row some token owns, and vice versa.
  if (row.mcpTokenId !== args.mcpTokenId) {
    return { status: "not_found" };
  }

  if (row.status === "denied") {
    return {
      status: "denied",
      by: await displayName(args.region, row.decidedByUserId),
      note: row.decisionNote,
    };
  }
  if (row.status === "expired") return { status: "expired" };
  if (row.status === "pending") {
    // Past its deadline but not yet swept: report the truth, not the label.
    if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };
    return { status: "pending", expiresAt: row.expiresAt.getTime() };
  }

  // Approved. Two questions, in order.
  //
  // 1. Was the grant CONSUMED? claimedAt is set BEFORE the engine audits and
  //    executes, so a claim alone does not mean the write landed — the
  //    statement can still fail in Postgres afterwards. Reporting "executed"
  //    off claimedAt told the agent a write had happened when it may not have,
  //    which is the worst thing this tool can say. Confirm against the EXECUTED
  //    audit row for the claiming attempt; without one the honest answer is
  //    "the grant is spent and I cannot confirm the outcome".
  if (row.claimedAt) {
    const executed = row.claimedQueryId
      ? await getDb(args.region)
          .select({ id: auditEventsIndex.id })
          .from(auditEventsIndex)
          .where(
            and(
              eq(auditEventsIndex.queryId, row.claimedQueryId),
              eq(auditEventsIndex.eventType, "EXECUTED"),
            ),
          )
          .limit(1)
      : [];
    return executed.length > 0 ? { status: "executed" } : { status: "consumed" };
  }

  // 2. Is it still collectable? claimSettled requires expiresAt > now, so an
  //    approved grant past its deadline can never be claimed. Reporting
  //    "approved" for one would tell the agent to run a statement that will
  //    only ever open a fresh request.
  if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };

  return {
    status: "approved",
    by: await displayName(args.region, row.decidedByUserId),
    note: row.decisionNote,
  };
}

/** True when this deployment can actually answer a held write.
 *
 *  Both halves are required: the secret mints the per-project bearer, the origin
 *  tells the engine where to send the request. Absent is a perfectly valid
 *  deployment — approvals are opt-in — which is exactly why enabling the toggle
 *  there is a trap: the engine gets no gate, so every write the policy permits
 *  is refused with no reviewable request ever created. Fail-closed, but
 *  permanently and invisibly, which is the worst shape a safety feature can
 *  take. Callers gate the SAVE on this rather than letting it happen. */
export function approvalGateConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.MIDPLANE_APPROVAL_SECRET &&
      (env.MIDPLANE_APPROVAL_CALLBACK_ORIGIN ?? env.MIDPLANE_APP_ORIGIN),
  );
}
