// The query path, in order:
//
//   ATTEMPTED (durable) → evaluate → [check taint] → DECIDED (durable)
//     → allow: [record taint] → execute → EXECUTED | FAILED
//     → hold:  count → file → APPROVAL filed (durable)
//              → approved: claim → APPROVAL claimed (durable) → [record taint]
//                          → execute with the row-count check → EXECUTED | FAILED
//
// If either of the first two audit writes fails, nothing reaches Postgres,
// and a claimed write runs only once its claim is durable too. A result
// carrying untrusted content taints the grant before it runs, so a failed
// taint record refuses the read rather than returning it.
//
// The grant's taint is checked only when the verdict depends on it (a write,
// or a secret table), and any doubt counts as tainted. A linked gateway keeps
// taint and held writes in Midplane Cloud; local mode keeps taint in its
// audit file and can't approve.
//
// A linked gateway serves only while it enforces a bundle: before the first
// one, while its project is paused, and while it is halted on a bundle it
// can't enforce, every call is refused before anything is recorded or run.

import { randomUUID } from "node:crypto";
import {
  type Evaluation,
  evaluate,
  type VisibleRelation,
  visibleRelations,
} from "@midplane/core";
import {
  type CatalogSnapshot,
  type CountPreviewResult,
  type DatabasePolicy,
  databaseScope,
  type PreviewCount,
  type RuleId,
} from "@midplane/protocol";
import {
  type Approvals,
  type Filed,
  heldMessage,
  instant,
  stateMessage,
  type TaintStore,
  TaintUnavailableError,
  UNREACHABLE_TAINT,
  unclaimableMessage,
  word,
} from "./approvals.ts";
import {
  AuditUnavailableError,
  type AuditWriter,
  type HeldStatements,
} from "./audit.ts";
import type { VerifiedCaller } from "./auth.ts";
import { introspect } from "./catalog.ts";
import {
  type DatabaseExecutor,
  ExecutionError,
  type Limits,
  type QueryResult,
  RowCountError,
  StoppedError,
} from "./executor.ts";

export interface DatabaseRuntime {
  id: string;
  /** Null while no enforced bundle covers this database: it isn't served. */
  policy: DatabasePolicy | null;
  executor: Pick<DatabaseExecutor, "run" | "withReadOnly" | "ping">;
  catalog: CatalogSnapshot;
  refreshedAt: number;
}

export interface GatewayOptions {
  databases: Map<string, DatabaseRuntime>;
  audit: AuditWriter & HeldStatements;
  /**
   * Where taint is kept: the audit file in local mode, the cloud in linked
   * mode (set by `useLink`; until then every grant counts as tainted).
   */
  taint?: TaintStore;
  salt: string | null;
  limits: Limits;
  mode: "local" | "linked";
  now?: () => Date;
}

/** Whether the gateway enforces a policy now, and if not, why. */
export type Enforcement =
  | { state: "enforcing" }
  | { state: "paused" }
  | { state: "halted"; reason: string }
  | { state: "waiting"; reason: string };

/** A held write's request, as the agent may see it. */
export interface HeldApproval {
  id: string;
  status: string;
  preview: PreviewCount | null;
  expires_at: string;
  review_url: string;
}

export type QueryOutcome =
  | {
      kind: "ok";
      result: QueryResult;
      taints: boolean;
      /** Set when a person approved this write. */
      approval?: { id: string; decidedBy: string };
    }
  | { kind: "deny"; rule: RuleId; reason: string }
  | { kind: "held"; reason: string; approval?: HeldApproval }
  | {
      kind: "failed";
      sqlstate: string | null;
      message: string;
      /**
       * The message is Postgres' own (it has a SQLSTATE and isn't withheld);
       * otherwise Midplane wrote it.
       */
      fromPostgres: boolean;
    }
  | { kind: "unavailable"; message: string };

/** Don't re-read the catalog for every unknown name an agent tries. */
const REFRESH_INTERVAL_MS = 5_000;

const UNKNOWN_TAINT_SECRET =
  "Midplane denied this query because it touches a table labeled secret, and Midplane Cloud couldn't confirm just now whether this agent has read untrusted content. Secret tables stay closed until it can; try again shortly.";
const UNKNOWN_TAINT_WRITE =
  "Midplane Cloud couldn't confirm just now whether this agent has read untrusted content, so this write was neither filed for approval nor run. Try again shortly.";

/** The longest a held write's count may run or wait for a lock. */
const COUNT_TIMEOUT_MS = 5_000;

export class Gateway {
  private readonly o: GatewayOptions;
  private readonly now: () => Date;
  private state: Enforcement;
  private taintStore: TaintStore;
  private approvals: Approvals | null = null;
  /** The bundle the enforced policies came from; null in local mode. */
  private policyVersion: number | null = null;

  constructor(options: GatewayOptions & { enforcement?: Enforcement }) {
    this.o = options;
    this.now = options.now ?? (() => new Date());
    this.state = options.enforcement ?? { state: "enforcing" };
    this.taintStore = options.taint ?? UNREACHABLE_TAINT;
  }

  /** Linked mode: keep taint and file held writes through the link. */
  useLink(link: TaintStore & Approvals): void {
    this.taintStore = link;
    this.approvals = link;
  }

  get enforcement(): Enforcement {
    return this.state;
  }

  get mode(): "local" | "linked" {
    return this.o.mode;
  }

  /** Every database this gateway has a connection for, served or not. */
  get configuredIds(): string[] {
    return [...this.o.databases.keys()];
  }

  /** The databases an enforced policy covers. */
  get databaseIds(): string[] {
    return [...this.o.databases.values()]
      .filter((d) => d.policy !== null)
      .map((d) => d.id);
  }

  /** Salt for masks, if configured: a policy with masks can't be enforced without it. */
  get hasSalt(): boolean {
    return this.o.salt !== null;
  }

  /**
   * Enforce a complete set of policies, replacing the previous set: a
   * database missing from it stops being served. One synchronous step, so no
   * call sees half of one bundle and half of another.
   */
  enforce(
    policies: ReadonlyMap<string, DatabasePolicy>,
    version: number | null = null,
  ): void {
    for (const db of this.o.databases.values()) {
      db.policy = policies.get(db.id) ?? null;
    }
    this.policyVersion = version;
    this.state = { state: "enforcing" };
  }

  /** Stop serving: the project is paused, or its bundle can't be enforced. */
  suspend(state: Exclude<Enforcement, { state: "enforcing" }>): void {
    this.state = state;
  }

  /** Why nothing may run now, or null while a policy is enforced. */
  refusal(): string | null {
    switch (this.state.state) {
      case "enforcing":
        return null;
      case "paused":
        return "This project is paused in Midplane Cloud, so this gateway runs nothing until someone resumes it.";
      case "halted":
        return `This gateway has stopped enforcing: ${this.state.reason} Nothing runs until Midplane Cloud publishes a policy it can enforce.`;
      case "waiting":
        return `This gateway has no policy from Midplane Cloud yet (${this.state.reason}), so nothing runs.`;
    }
  }

  /** The database a call names, or the only one when it names none. */
  database(id: string | undefined): DatabaseRuntime | string {
    const served = this.databaseIds;
    if (id === undefined) {
      const [only] = served;
      if (served.length === 1 && only)
        return this.o.databases.get(only) as DatabaseRuntime;
      if (served.length === 0) return "this gateway serves no databases yet";
      return `name a database: one of ${served.join(", ")}`;
    }
    const db = this.o.databases.get(id);
    if (!db || db.policy === null)
      return `no database named "${id}"; one of ${served.join(", ") || "none"}`;
    return db;
  }

  async refreshCatalog(db: DatabaseRuntime, force = false): Promise<void> {
    const at = this.now().getTime();
    if (!force && at - db.refreshedAt < REFRESH_INTERVAL_MS) return;
    db.refreshedAt = at;
    db.catalog = await db.executor.withReadOnly(introspect);
  }

  /** Every configured database's catalog, as last read. */
  catalogs(): { id: string; catalog: CatalogSnapshot }[] {
    return [...this.o.databases.values()].map((d) => ({
      id: d.id,
      catalog: d.catalog,
    }));
  }

  /** Re-read the catalogs older than `maxAgeMs`; one that can't be read keeps the last. */
  async refreshStale(maxAgeMs: number): Promise<void> {
    const at = this.now().getTime();
    await Promise.all(
      [...this.o.databases.values()]
        .filter((d) => at - d.refreshedAt >= maxAgeMs)
        .map((d) => this.refreshCatalog(d, true).catch(() => {})),
    );
  }

  /** Re-read one database's catalog now; on failure, only an error code. */
  async rereadCatalog(
    id: string,
  ): Promise<
    { ok: true; catalog: CatalogSnapshot } | { ok: false; code: string | null }
  > {
    const db = this.o.databases.get(id);
    if (!db) return { ok: false, code: null };
    try {
      await this.refreshCatalog(db, true);
      return { ok: true, catalog: db.catalog };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return {
        ok: false,
        code: typeof code === "string" ? code.slice(0, 32) : null,
      };
    }
  }

  private evaluate(
    db: DatabaseRuntime,
    policy: DatabasePolicy,
    caller: VerifiedCaller,
    sql: string,
    intent: string,
    tainted: boolean,
  ): Evaluation {
    return evaluate({
      sql,
      databaseId: db.id,
      policy,
      catalog: db.catalog,
      caller: caller.caller,
      tainted,
      intent,
    });
  }

  async query(
    caller: VerifiedCaller,
    input: { database?: string; sql: string; intent?: string },
  ): Promise<QueryOutcome> {
    const refusal = this.refusal();
    if (refusal) return { kind: "unavailable", message: refusal };
    const db = this.database(input.database);
    if (typeof db === "string")
      return { kind: "deny", rule: "scope", reason: db };
    // The policy this call is decided and executed under, even if a new
    // bundle lands while it runs.
    const policy = db.policy as DatabasePolicy;
    const policyVersion = this.policyVersion;
    const queryId = randomUUID();
    const intent = input.intent ?? "";
    const grantId = caller.claims.grant_id;

    try {
      this.o.audit.append({
        event: "ATTEMPTED",
        query_id: queryId,
        at: this.at(),
        database: db.id,
        sub: caller.claims.sub,
        client_id: caller.claims.client_id,
        grant_id: grantId,
        sql: input.sql,
        intent,
      });
    } catch (err) {
      return unavailable(err);
    }

    let e = this.evaluate(db, policy, caller, input.sql, intent, false);
    // A name the catalog doesn't know may be new: re-read once and retry.
    if (e.verdict === "deny" && e.rule === "unresolved") {
      try {
        const before = db.refreshedAt;
        await this.refreshCatalog(db);
        if (db.refreshedAt !== before)
          e = this.evaluate(db, policy, caller, input.sql, intent, false);
      } catch {
        // Keep the denial.
      }
    }
    // Taint only narrows, so it is asked only when it could change the
    // verdict; a check that fails counts as tainted.
    const taint = e.effects.dependsOnTaint
      ? await this.taintStore.checkTaint(grantId)
      : "clean";
    if (taint !== "clean") {
      e = this.evaluate(db, policy, caller, input.sql, intent, true);
    }
    // Unknown taint closes what taint closes, but neither the agent nor the
    // audit log is told it read untrusted content.
    if (taint === "unknown" && e.verdict === "deny" && e.rule === "containment")
      e = { ...e, reason: UNKNOWN_TAINT_SECRET };

    try {
      this.o.audit.append({
        event: "DECIDED",
        query_id: queryId,
        at: this.at(),
        verdict: e.verdict,
        rule: e.verdict === "deny" ? e.rule : null,
        reason: e.verdict === "deny" ? e.reason : null,
        class: e.verdict === "hold" ? e.class : null,
        fingerprint: e.effects.fingerprint,
        tables: e.effects.tables,
        taints: e.effects.taints,
        masked: e.effects.masked,
        policy_version: policyVersion,
      });
    } catch (err) {
      return unavailable(err);
    }

    // Nobody is asked to approve a write only a failed check holds.
    if (taint === "unknown" && e.verdict === "hold" && e.cause === "taint")
      return { kind: "unavailable", message: UNKNOWN_TAINT_WRITE };
    if (e.verdict === "deny")
      return { kind: "deny", rule: e.rule, reason: e.reason };
    if (e.verdict === "hold")
      return this.held(db, policy, caller, input.sql, intent, queryId, e);
    return this.execute(db, policy, caller, queryId, e);
  }

  private at(): string {
    return this.now().toISOString();
  }

  /** Record taint, when running this taints the grant; null when it may run. */
  private async recordTaint(
    grantId: string,
    e: Exclude<Evaluation, { verdict: "deny" }>,
    queryId: string,
  ): Promise<QueryOutcome | null> {
    const [source] = e.effects.taintSources;
    if (!source) return null;
    try {
      await this.taintStore.taint(grantId, source, queryId);
      return null;
    } catch (err) {
      return {
        kind: "unavailable",
        message:
          err instanceof TaintUnavailableError && this.o.mode === "linked"
            ? `This statement returns or stores content from columns labeled untrusted, and Midplane Cloud couldn't record that (${err.message}), so nothing was run.`
            : `This statement returns or stores content from columns labeled untrusted, and that couldn't be recorded, so nothing was run: ${(err as Error).message}`,
      };
    }
  }

  /** Run an allowed or claimed plan; `approved` carries the claim. */
  private async execute(
    db: DatabaseRuntime,
    policy: DatabasePolicy,
    caller: VerifiedCaller,
    queryId: string,
    e: Exclude<Evaluation, { verdict: "deny" }>,
    approved?: {
      id: string;
      decidedBy: string;
      preview: { count: number; exact: boolean } | null;
    },
  ): Promise<QueryOutcome> {
    const refused = await this.recordTaint(caller.claims.grant_id, e, queryId);
    if (refused) {
      if (approved) {
        this.record(() => ({
          event: "FAILED",
          query_id: queryId,
          at: this.at(),
          sqlstate: null,
          message: refused.kind === "unavailable" ? refused.message : "taint",
        }));
        this.report(approved.id, queryId, null, "taint");
      }
      return refused;
    }
    const masked = Object.keys(policy.masks).length > 0;
    try {
      const result = await db.executor.run(e.plan, {
        salt: masked ? this.o.salt : null,
        limits: this.o.limits,
        stripDetail: masked || e.effects.readsUntrusted,
        ...(approved?.preview ? { expectRows: approved.preview } : {}),
        // A claimed write checks again once its connection comes: recording
        // taint and waiting for the pool both take time.
        ...(approved ? { stop: () => this.stopped(db, policy) } : {}),
      });
      this.record(() => ({
        event: "EXECUTED",
        query_id: queryId,
        at: this.at(),
        row_count: result.rowCount,
        duration_ms: Math.round(result.durationMs),
        truncated: result.truncated,
      }));
      if (approved) this.report(approved.id, queryId, result.rowCount, null);
      if (!e.plan.readOnly) await this.refreshCatalog(db, true).catch(() => {});
      return {
        kind: "ok",
        result,
        taints: e.effects.taints,
        ...(approved
          ? { approval: { id: approved.id, decidedBy: approved.decidedBy } }
          : {}),
      };
    } catch (err) {
      if (approved && err instanceof StoppedError)
        return this.spent(approved.id, queryId, err.message);
      const x =
        err instanceof ExecutionError
          ? err
          : new ExecutionError(null, String(err), null);
      // Postgres can quote a value it read. From a table with untrusted
      // columns that's content the agent would get without its grant being
      // tainted, so only the SQLSTATE is told, and kept. An error without a
      // SQLSTATE is Midplane's own or the connection's, and quotes no row.
      const withheld = e.effects.readsUntrusted && x.sqlstate !== null;
      const message = withheld
        ? `Postgres refused this statement (SQLSTATE ${x.sqlstate}). Its message is withheld: this statement reads a table with columns labeled untrusted, and the message could quote one of their values.`
        : x.sqlstate === null && !(x instanceof RowCountError)
          ? `The statement couldn't run: ${x.message}`
          : x.detail
            ? `${x.message} (${x.detail})`
            : x.message;
      this.record(() => ({
        event: "FAILED",
        query_id: queryId,
        at: this.at(),
        sqlstate: x.sqlstate,
        message,
      }));
      if (approved) {
        this.report(
          approved.id,
          queryId,
          x instanceof RowCountError ? x.rowCount : null,
          x instanceof RowCountError ? "row_count" : (x.sqlstate ?? "failed"),
        );
      }
      if (approved && x instanceof RowCountError) {
        return {
          kind: "failed",
          sqlstate: null,
          fromPostgres: false,
          message: `Request ${approved.id} was approved for ${x.approved.exact ? "" : "at most "}${x.approved.count} rows, but this write changed ${x.rowCount ?? "an unknown number of"}, so Midplane rolled it back and nothing changed. The approval is used up; re-run the statement to request a new one.`,
        };
      }
      return {
        kind: "failed",
        sqlstate: x.sqlstate,
        message,
        fromPostgres: x.sqlstate !== null && !withheld,
      };
    }
  }

  /** Tell the cloud how a claimed write went. Best effort: the audit log is the record. */
  private report(
    approvalId: string,
    queryId: string,
    rowCount: number | null,
    code: string | null,
  ): void {
    this.approvals
      ?.outcome(approvalId, {
        query_id: queryId,
        executed: code === null,
        row_count: rowCount,
        code,
      })
      .catch((err) =>
        process.stderr.write(
          `${JSON.stringify({ level: "warn", msg: "approval outcome not reported", approval: approvalId, error: String(err) })}\n`,
        ),
      );
  }

  /**
   * Count the rows a held write would change, read-only, and briefly: a
   * count runs, and waits for a lock, for no longer than COUNT_TIMEOUT_MS
   * (or the policy's shorter limits), whatever the policy allows the write
   * itself, so a slow statement can't tie up the agent or a recount.
   */
  private async count(
    db: DatabaseRuntime,
    policy: DatabasePolicy,
    e: Extract<Evaluation, { verdict: "hold" }>,
  ): Promise<PreviewCount | null> {
    if (!e.preview) return null;
    const masked = Object.keys(policy.masks).length > 0;
    try {
      const r = await db.executor.run(
        {
          ...e.plan,
          readOnly: true,
          statement: e.preview.sql,
          outputColumns: [],
          statementTimeoutMs: Math.min(
            e.plan.statementTimeoutMs,
            COUNT_TIMEOUT_MS,
          ),
          lockTimeoutMs: Math.min(e.plan.lockTimeoutMs, COUNT_TIMEOUT_MS),
        },
        {
          salt: masked ? this.o.salt : null,
          limits: { maxRows: 1, maxBytes: 1024 },
          stripDetail: true,
        },
      );
      const n = Number(r.rows[0]?.[0]);
      if (!Number.isSafeInteger(n) || n < 0)
        return { count: null, exact: e.preview.exact, code: "no_count" };
      return { count: n, exact: e.preview.exact, code: null };
    } catch (err) {
      const code = err instanceof ExecutionError ? err.sqlstate : null;
      return {
        count: null,
        exact: e.preview.exact,
        code: (code ?? "failed").slice(0, 32),
      };
    }
  }

  /** A held write: file it, and run it once a person has approved it. */
  private async held(
    db: DatabaseRuntime,
    policy: DatabasePolicy,
    caller: VerifiedCaller,
    sql: string,
    intent: string,
    queryId: string,
    e: Extract<Evaluation, { verdict: "hold" }>,
  ): Promise<QueryOutcome> {
    const approvals = this.approvals;
    if (!approvals) {
      return {
        kind: "held",
        reason:
          this.o.mode === "local"
            ? "This write needs a person's approval, and this gateway runs in local mode, where approvals are unavailable. Link the gateway to Midplane Cloud to have writes like this approved."
            : "This write needs a person's approval, and this gateway can't reach Midplane Cloud to file it yet, so it was not run.",
      };
    }
    const grantId = caller.claims.grant_id;
    const preview = await this.count(db, policy, e);
    let filed: Filed;
    try {
      filed = await approvals.file({
        query_id: queryId,
        database: db.id,
        sql,
        intent,
        grant_id: grantId,
        sub: caller.claims.sub,
        client_id: caller.claims.client_id,
        approval_key: e.approvalKey,
        class: e.class,
        cause: e.cause,
        tables: e.effects.tables.slice(0, 256),
        preview,
      });
    } catch (err) {
      return {
        kind: "unavailable",
        message: `This write needs a person's approval, and it couldn't be filed with Midplane Cloud (${(err as Error).message}), so nothing was run.`,
      };
    }
    try {
      this.o.audit.append({
        event: "APPROVAL",
        query_id: queryId,
        at: this.at(),
        approval_id: filed.id,
        step: "filed",
        status: filed.status,
        preview: filed.preview
          ? {
              count: filed.preview.count,
              exact: filed.preview.exact,
              code: filed.preview.code,
            }
          : null,
      });
    } catch (err) {
      return unavailable(err);
    }
    // The agent gets the filing answer's fields checked, never as sent:
    // nothing signs it.
    const approval: HeldApproval = {
      id: filed.id,
      status: word(filed.status),
      preview: filed.preview && {
        count: filed.preview.count,
        exact: filed.preview.exact,
        code: filed.preview.code && word(filed.preview.code),
      },
      expires_at: instant(filed.expires_at),
      review_url: filed.review_url,
    };
    if (filed.status !== "approved") {
      return {
        kind: "held",
        reason: heldMessage({
          filed,
          cause: e.cause,
          klass: e.class,
          now: this.now(),
        }),
        approval,
      };
    }

    // Approved: claim it once, then run it against the count approved. An
    // approval this gateway already ran never runs here again, even if the
    // cloud's database says it is unclaimed.
    if (this.o.audit.claimedHere(filed.id)) {
      return {
        kind: "held",
        reason: unclaimableMessage(filed.id, "used"),
        approval: { ...approval, status: "used" },
      };
    }
    // A pause or a new bundle while this was filed stops it before the claim
    // uses it up...
    const stopped = this.stopped(db, policy);
    if (stopped) return { kind: "unavailable", message: stopped };
    let claimed: Awaited<ReturnType<Approvals["claim"]>>;
    try {
      claimed = await approvals.claim(
        filed.id,
        { approval_key: e.approvalKey, grant_id: grantId, query_id: queryId },
        { database: db.id },
      );
    } catch (err) {
      // The cloud may have claimed it and the answer was lost: the push
      // carries this, so the request shows it was claimed and didn't run.
      this.record(() => ({
        event: "APPROVAL",
        query_id: queryId,
        at: this.at(),
        approval_id: filed.id,
        step: "claim_failed",
        status: "unconfirmed",
        preview: null,
      }));
      return {
        kind: "unavailable",
        message: `Request ${filed.id} was approved, but Midplane couldn't confirm the approval (${(err as Error).message}), so nothing was run.`,
      };
    }
    if (!claimed.ok) {
      return {
        kind: "held",
        reason: unclaimableMessage(filed.id, claimed.status),
        approval: { ...approval, status: word(claimed.status) },
      };
    }
    try {
      this.o.audit.append({
        event: "APPROVAL",
        query_id: queryId,
        at: this.at(),
        approval_id: filed.id,
        step: "claimed",
        status: "used",
        preview: claimed.preview ? { ...claimed.preview, code: null } : null,
      });
    } catch (err) {
      this.report(filed.id, queryId, null, "audit");
      return unavailable(err);
    }
    // ...and one while it was claimed stops it before it runs.
    const stoppedSince = this.stopped(db, policy);
    if (stoppedSince) return this.spent(filed.id, queryId, stoppedSince);
    return this.execute(db, policy, caller, queryId, e, {
      id: filed.id,
      decidedBy: claimed.decidedBy,
      preview: claimed.preview,
    });
  }

  /**
   * A claimed approval that won't run: the log records that it didn't, and
   * the cloud hears why (the gateway's state, or `policy_changed`).
   */
  private spent(
    approvalId: string,
    queryId: string,
    reason: string,
  ): QueryOutcome {
    this.record(() => ({
      event: "FAILED",
      query_id: queryId,
      at: this.at(),
      sqlstate: null,
      message: reason,
    }));
    this.report(
      approvalId,
      queryId,
      null,
      this.refusal() ? this.state.state : "policy_changed",
    );
    return { kind: "unavailable", message: reason };
  }

  /**
   * Why a held write may no longer run: the gateway stopped serving, or a
   * bundle landed since it was evaluated, which may no longer hold it.
   */
  private stopped(db: DatabaseRuntime, policy: DatabasePolicy): string | null {
    const refusal = this.refusal();
    if (refusal) return refusal;
    // Bundles republish for other reasons (a revoked token, another
    // database); only a different policy for this database stops it.
    if (
      db.policy !== policy &&
      JSON.stringify(db.policy) !== JSON.stringify(policy)
    )
      return "Midplane Cloud published a new policy while this write was being filed, so it was not run. Re-run it to have it evaluated under the new policy.";
    return null;
  }

  /**
   * Count a held write again for its approver: the statement comes from
   * this gateway's own audit log, never from the cloud, and is evaluated
   * under the current policy and the grant's current taint.
   */
  async recount(approvalId: string): Promise<CountPreviewResult> {
    const none = { count: null, exact: null, code: null };
    const held = this.o.audit.heldStatement(approvalId);
    const db = held ? this.o.databases.get(held.database) : undefined;
    if (!held) return { status: "unknown", ...none };
    if (this.refusal())
      return { status: "failed", ...none, code: this.state.state };
    if (!db?.policy) return { status: "failed", ...none, code: "no_policy" };
    const policy = db.policy;
    const caller = {
      sub: held.sub,
      client_id: held.client_id,
      grant_id: held.grant_id,
      // It was held, so its grant could write here; scope was checked then.
      scopes: [databaseScope(db.id, "write")],
    };
    const taint = await this.taintStore.checkTaint(held.grant_id);
    const e = evaluate({
      sql: held.sql,
      databaseId: db.id,
      policy,
      catalog: db.catalog,
      caller,
      tainted: taint !== "clean",
      intent: held.intent,
    });
    // Unknown taint closes what taint closes: that the write isn't held then
    // says nothing about today's policy.
    if (e.verdict !== "hold")
      return taint === "unknown"
        ? { status: "failed", ...none, code: "taint_unknown" }
        : { status: "not_held", ...none };
    // Recorded before the count reaches the database, like any statement.
    try {
      this.o.audit.append({
        event: "APPROVAL",
        query_id: held.query_id,
        at: this.at(),
        approval_id: approvalId,
        step: "recount",
        status: "pending",
        preview: null,
      });
    } catch {
      return { status: "failed", ...none, code: "audit" };
    }
    const preview = await this.count(db, policy, e);
    if (!preview) return { status: "counted", ...none };
    return {
      status: preview.count === null ? "failed" : "counted",
      ...preview,
    };
  }

  /** Where a held write stands, for the grant that filed it. */
  async checkApproval(
    caller: VerifiedCaller,
    approvalId: string,
  ): Promise<{ text: string; isError: boolean }> {
    if (this.o.mode === "local") {
      return {
        text: "Approvals are unavailable: this gateway runs in local mode. Link it to Midplane Cloud to have held writes approved.",
        isError: true,
      };
    }
    const refusal = this.refusal();
    if (refusal) return { text: refusal, isError: true };
    if (!this.approvals) {
      return {
        text: "This gateway can't reach Midplane Cloud yet, so it can't check approvals.",
        isError: true,
      };
    }
    let state: Awaited<ReturnType<Approvals["state"]>>;
    try {
      state = await this.approvals.state(approvalId, caller.claims.grant_id);
    } catch (err) {
      return {
        text: `Midplane couldn't check request ${approvalId} (${(err as Error).message}).`,
        isError: true,
      };
    }
    if (!state) {
      return {
        text: `No request "${approvalId}" was filed by this agent's grant.`,
        isError: true,
      };
    }
    if (state.id !== approvalId) {
      return {
        text: `Midplane Cloud answered about another request than "${approvalId}", so the gateway can't say where it stands.`,
        isError: true,
      };
    }
    // The statement to re-run comes from this gateway's own log, never
    // from the cloud's answer, which nothing signs, and only for the grant
    // that filed it.
    let held: ReturnType<typeof this.o.audit.heldStatement> = null;
    try {
      held = this.o.audit.heldStatement(approvalId);
    } catch {
      // Without the log, the agent is told to re-run what it sent.
    }
    const mine = held?.grant_id === caller.claims.grant_id ? held : null;
    return {
      // The database is the one this gateway filed it on, when it did.
      text: stateMessage(
        mine ? { ...state, database: mine.database } : state,
        mine ? { sql: mine.sql, intent: mine.intent } : null,
      ),
      isError: false,
    };
  }

  /** After execution the statement has run; a failed record is reported, not undone. */
  private record(event: () => Parameters<AuditWriter["append"]>[0]): void {
    try {
      this.o.audit.append(event());
    } catch (err) {
      process.stderr.write(
        `${JSON.stringify({ level: "error", msg: "audit write after execution failed", error: String(err) })}\n`,
      );
    }
  }

  /** Relations the caller may read, or why it can't list them. */
  describe(
    caller: VerifiedCaller,
    database: string | undefined,
  ): VisibleRelation[] | string {
    const refusal = this.refusal();
    if (refusal) return refusal;
    const db = this.database(database);
    if (typeof db === "string") return db;
    const scopes = new Set(caller.caller.scopes);
    if (
      !scopes.has(databaseScope(db.id, "read")) &&
      !scopes.has(databaseScope(db.id, "write"))
    ) {
      return `this agent has no access to database "${db.id}"`;
    }
    return visibleRelations(db.policy as DatabasePolicy, db.catalog);
  }

  async ready(): Promise<boolean> {
    if (this.refusal()) return false;
    const checks = await Promise.all(
      [...this.o.databases.values()].map((d) => d.executor.ping()),
    );
    return checks.every(Boolean);
  }
}

function unavailable(err: unknown): QueryOutcome {
  const message =
    err instanceof AuditUnavailableError
      ? "The audit log can't be written, so nothing was run. Every statement is recorded before it runs."
      : `Nothing was run: ${String(err)}`;
  return { kind: "unavailable", message };
}
