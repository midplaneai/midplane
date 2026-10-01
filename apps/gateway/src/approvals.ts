// Held writes and taint, as the gateway sees them. A linked gateway files a
// held write with Midplane Cloud, claims it once a person approved it, and
// keeps taint there, so every instance sees the same requests and the same
// taint. Local mode has no approver and keeps taint in its audit file.
//
// The messages here are what the agent reads: each says what happened, why,
// and what it can do next.

import type { TaintSource } from "@midplane/core";
import {
  type ApprovalOutcome,
  type ApprovalState,
  type ClaimRequest,
  DatabaseIdSchema,
  type FileApprovalRequest,
  type FiledApproval,
  type HoldCause,
  type PreviewCount,
} from "@midplane/protocol";

export type { TaintSource };

/** A filing's answer, with the review URL the gateway built itself. */
export type Filed = FiledApproval & { review_url: string };

/** Where a request stands, with the review URL the gateway built itself. */
export type State = ApprovalState & { review_url: string };

/**
 * A grant's taint as checked: `unknown` when the check failed or its answer
 * didn't verify. Unknown counts as tainted, and the agent is told the check
 * failed rather than that it read untrusted content.
 */
export type TaintCheck = "tainted" | "clean" | "unknown";

/** Where a grant's taint is kept. */
export interface TaintStore {
  /** The grant's taint. Never throws: a check that fails is `unknown`. */
  checkTaint(grantId: string): Promise<TaintCheck>;
  /**
   * Record that the grant read untrusted content, before the statement
   * runs. Resolves once the record is durable or the cloud confirmed it;
   * throws otherwise, and the caller refuses the statement.
   */
  taint(grantId: string, source: TaintSource, queryId: string): Promise<void>;
}

/** A person's approval, verified against the cloud's signature. */
export type Claimed =
  | {
      ok: true;
      /** The count the person saw, which the write must match. */
      preview: { count: number; exact: boolean } | null;
      decidedBy: string;
    }
  | { ok: false; status: string };

/** Midplane Cloud's approval desk, reached over the link. */
export interface Approvals {
  /** File a held write, or find the request that governs it. */
  file(request: FileApprovalRequest): Promise<Filed>;
  /**
   * Claim an approved request, once. Throws when the cloud can't be reached
   * or its answer doesn't verify: nothing may run then.
   */
  claim(
    id: string,
    request: Omit<ClaimRequest, "nonce">,
    expect: { database: string },
  ): Promise<Claimed>;
  /** Report how a claimed write went. */
  outcome(id: string, outcome: ApprovalOutcome): Promise<void>;
  /** Where a request stands, for the grant that filed it; null if not found. */
  state(id: string, grantId: string): Promise<State | null>;
}

/** Taint that can't be recorded: the statement is refused. */
export class TaintUnavailableError extends Error {
  override name = "TaintUnavailableError";
}

/** Taint kept in the local audit file (local mode). */
export function localTaintStore(log: {
  isTainted(grantId: string): boolean;
  taint(grantId: string, source: string, at: string): void;
}): TaintStore {
  return {
    async checkTaint(grantId) {
      return log.isTainted(grantId) ? "tainted" : "clean";
    },
    async taint(grantId, source, queryId) {
      try {
        log.taint(
          grantId,
          `${source.table}.${source.column} (query ${queryId})`,
          new Date().toISOString(),
        );
      } catch (err) {
        throw new TaintUnavailableError(String(err));
      }
    },
  };
}

/**
 * A linked gateway before its link is open: nothing can be recorded or
 * filed, and every grant's taint is unknown.
 */
export const UNREACHABLE_TAINT: TaintStore = {
  async checkTaint() {
    return "unknown";
  },
  async taint() {
    throw new TaintUnavailableError("the link to Midplane Cloud isn't open");
  },
};

// ── what the agent is told ─────────────────────────────────────────────────

/** Controls, line breaks, and invisible or direction-changing characters. */
const UNSEEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g;

/**
 * Text Midplane Cloud relays without a signature: a person's name and note,
 * or a refusal's description. Anyone who can write to the cloud's database
 * can choose it, so the agent gets it on one line, capped and quoted, never
 * as the gateway's own words.
 */
export function relayed(text: string, max = 280): string {
  const line = text.replace(UNSEEN, " ").trim();
  return JSON.stringify(
    line.length > max ? `${line.slice(0, max - 1)}…` : line,
  );
}

/** A status or code from the cloud, if it is a plain word; the cloud may add statuses. */
export function word(status: string): string {
  return /^[A-Za-z0-9_]{1,32}$/.test(status) ? status : "unrecognized";
}

/** A time from the cloud, printed by the gateway; anything else isn't printed. */
export function instant(at: string): string {
  const t = Date.parse(at);
  return Number.isFinite(t)
    ? new Date(t).toISOString()
    : "an unrecognized time";
}

/** Who decided, as the cloud names them. */
export function decider(name: string | null): string {
  return name
    ? `${relayed(name, 80)} (as Midplane Cloud names them)`
    : "a person";
}

function withNote(note: string | null): string {
  return note ? `, noting: ${relayed(note)}` : "";
}

function rows(n: number): string {
  return n === 1 ? "1 row" : `${n} rows`;
}

/** "would change 3 rows", or why there is no count. */
export function countText(preview: PreviewCount | null): string {
  if (!preview)
    return "can't be counted in advance (it calls a volatile function or changes the schema)";
  if (preview.count === null)
    return `couldn't be counted${preview.code ? ` (${word(preview.code)})` : ""}`;
  return preview.exact
    ? `would change ${rows(preview.count)}`
    : `would change at most ${rows(preview.count)}`;
}

function why(cause: HoldCause, klass: string): string {
  return cause === "class"
    ? `this database holds ${klass === "schema_changes" ? "schema changes" : "row changes"} for a person's approval`
    : "this agent has read content from columns labeled untrusted since it was authorized, so its writes wait for a person";
}

function ago(from: string, now: Date): string {
  const at = Date.parse(from);
  if (!Number.isFinite(at)) return "an unknown time";
  const minutes = Math.max(0, Math.round((now.getTime() - at) / 60_000));
  if (minutes < 1) return "less than a minute";
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

const recheck = (id: string) =>
  `call check_approval with approval_id "${id}" to see where it stands`;

/** A held write that didn't run: pending, denied, or a status a newer cloud added. */
export function heldMessage(o: {
  filed: Filed;
  cause: HoldCause;
  klass: string;
  now: Date;
}): string {
  const { filed } = o;
  if (filed.status === "denied") {
    return [
      `Request ${filed.id} was denied by ${decider(filed.decided_by)}${withNote(filed.note)}.`,
      "Re-running this write won't change that; a different statement or intent is a new request.",
    ].join(" ");
  }
  if (filed.status !== "pending") {
    return `Request ${filed.id} is ${word(filed.status)}, so nothing was run. Call check_approval with approval_id "${filed.id}" for details.`;
  }
  if (!filed.created) {
    return [
      `This write is still waiting for a person's approval (request ${filed.id}, filed ${ago(filed.filed_at, o.now)} ago; it expires at ${instant(filed.expires_at)}).`,
      `Review: ${filed.review_url}.`,
      `Once it is approved, re-run exactly this statement with the same intent, or ${recheck(filed.id)}.`,
    ].join(" ");
  }
  return [
    `Midplane held this write, and nothing ran: ${why(o.cause, o.klass)}.`,
    `It ${countText(filed.preview)}.`,
    `Request ${filed.id} is waiting for a decision at ${filed.review_url}${filed.replaces ? ` (it replaces ${filed.replaces})` : ""}.`,
    `Once it is approved, re-run exactly this statement with the same intent before ${instant(filed.expires_at)}, and it will run; or ${recheck(filed.id)}.`,
  ].join(" ");
}

/** An approved request that can't be claimed. */
export function unclaimableMessage(id: string, status: string): string {
  const reason =
    status === "used"
      ? "another run already used it"
      : status === "canceled"
        ? "its grant ended"
        : status === "expired"
          ? "it expired before it was used"
          : `it is ${word(status)}`;
  return `Request ${id} can't be used (${reason}), so nothing was run. Re-run the statement to file a new request.`;
}

/**
 * What `check_approval` says about a request. `statement` is the one this
 * gateway filed, from its own audit log; without it, the agent is told to
 * re-run what it sent.
 */
export function stateMessage(
  s: State,
  statement: { sql: string; intent: string } | null,
): string {
  const database =
    DatabaseIdSchema.safeParse(s.database).data ?? "unrecognized";
  const head = `Request ${s.id} on database ${database}`;
  switch (s.status) {
    case "pending":
      return `${head} is waiting for a person's decision until ${instant(s.expires_at)}. It ${countText(s.preview)}. Review: ${s.review_url}.`;
    case "approved":
      return statement
        ? [
            `${head} was approved by ${decider(s.decided_by)}. Re-run exactly this statement with exactly this intent before ${instant(s.expires_at)} to run it:`,
            `statement: ${statement.sql}`,
            `intent: ${JSON.stringify(statement.intent)}`,
          ].join("\n")
        : `${head} was approved by ${decider(s.decided_by)}. Re-run exactly the statement you filed, with the same intent, before ${instant(s.expires_at)} to run it.`;
    case "denied":
      return `${head} was denied by ${decider(s.decided_by)}${withNote(s.note)}. Re-running it won't change that.`;
    case "expired":
      return `${head} expired before anyone used it. Re-run the statement to file a new request.`;
    case "canceled":
      return `${head} was canceled because its grant ended.`;
    case "used": {
      const o = s.outcome;
      if (!o)
        return `${head} was approved and claimed by a run; its outcome hasn't been reported.`;
      return o.executed
        ? `${head} ran after approval and changed ${rows(o.row_count ?? 0)}.`
        : `${head} was claimed, but the write didn't complete${o.code ? ` (${word(o.code)})` : ""}; nothing changed. Re-run the statement to file a new request.`;
    }
    default:
      return `${head} is ${word(s.status)}; nothing will run for it.`;
  }
}
