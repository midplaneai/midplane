// Approval resolution against REAL Postgres.
//
// The properties here are all about concurrency and SQL semantics — a
// conditional UPDATE that must return exactly one row under a race, a partial
// unique index that must reject a second pending row but permit a second
// settled one. A mocked db would happily confirm whatever the mock was told to
// do, which is precisely the wrong oracle for this module.
//
// Gated on APPROVALS_LIVE_PG_DSN. Run with:
//   APPROVALS_LIVE_PG_DSN=postgres://postgres:pw@127.0.0.1:5433/mp_approvals \
//     ./node_modules/.bin/vitest run apps/web/test/approvals-live.test.ts
//
// Do NOT also export MIDPLANE_SELF_HOST on the command line — this file sets it
// inside its own vitest worker, and setting it process-wide breaks 31 tests in
// other files that assert cloud-mode behavior.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";

const DSN = process.env.APPROVALS_LIVE_PG_DSN;
const d = DSN ? describe : describe.skip;

// getDb() resolves its connection from env at first call, so these must be set
// before the module under test is imported.
if (DSN) {
  process.env.MIDPLANE_SELF_HOST = "1";
  process.env.DATABASE_URL = DSN;
}

const {
  grantKeyFor,
  resolveApproval,
  expireStaleApprovals,
} = await import("../src/lib/approvals.ts");

const { decideApproval, listPendingApprovals, listDecidedApprovals, getApproval } =
  await import("../src/lib/approval-queue.ts");

const { checkApprovalStatus } = await import("../src/lib/approvals.ts");

const BASE = {
  customerId: "c_live",
  projectId: "p_live",
  projectDatabaseId: "d_live",
  region: "eu" as const,
  queryId: "q1",
  sql: "UPDATE orders SET status='refunded' WHERE id=1",
  intent: "refund the duplicate charge",
  statementType: "UPDATE",
  tablesTouched: ["orders"],
  agentName: "Claude Code",
  mcpTokenId: "tok_a",
  expiresAfterSeconds: 1800,
};

// No real waiting: the hold polls through an injected sleep.
const NO_WAIT = { holdMs: 0, sleep: async () => {} };

d("approval resolution — live", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(DSN!, { max: 2, prepare: false, onnotice: () => undefined });
    await sql`INSERT INTO customers (id, org_id, email, region)
              VALUES ('c_live','o_live','live@x.test','eu') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO projects (id, customer_id, region)
              VALUES ('p_live','c_live','eu') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO project_databases (id, project_id, name, encrypted_dsn, kms_key_id)
              VALUES ('d_live','p_live','main','\\x00'::bytea,'k') ON CONFLICT DO NOTHING`;
    // A real approver row, so identity resolution is exercised rather than
    // silently falling back to the raw id on every assertion.
    await sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
              VALUES ('u_named','Dustin Lange','dustin@x.test',true,now(),now())
              ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
              VALUES ('u_noname','','nameless@x.test',true,now(),now())
              ON CONFLICT DO NOTHING`;
  });

  afterAll(async () => {
    // Explicit child-first order: projects carries a composite
    // (customer_id, region) FK that is NOT ON DELETE CASCADE, so deleting the
    // customer alone is rejected.
    await sql`DELETE FROM audit_events_index WHERE customer_id = 'c_live'`;
    await sql`DELETE FROM write_approvals WHERE project_database_id = 'd_live'`;
    await sql`DELETE FROM project_databases WHERE id = 'd_live'`;
    await sql`DELETE FROM projects WHERE id = 'p_live'`;
    await sql`DELETE FROM customers WHERE id = 'c_live'`;
    await sql`DELETE FROM "user" WHERE id IN ('u_named','u_noname')`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM write_approvals WHERE project_database_id = 'd_live'`;
    // Clean BEFORE, not after. A trailing DELETE at the end of a test body is
    // skipped when that test fails, and the leftover row then breaks the NEXT
    // run — which is how these fixtures first went bad.
    await sql`DELETE FROM audit_events_index WHERE customer_id = 'c_live'`;
  });

  async function decide(
    grantKey: string,
    status: "approved" | "denied",
    by = "dustin@x.test",
    note: string | null = null,
  ) {
    await sql`UPDATE write_approvals
                 SET status = ${status}, decided_by_user_id = ${by},
                     decision_note = ${note}, decided_at = now()
               WHERE grant_key = ${grantKey} AND status = 'pending'`;
  }

  it("opens exactly one pending request and reports it", async () => {
    const answer = await resolveApproval(BASE, NO_WAIT);
    expect(answer.status).toBe("pending");

    const rows = await sql`SELECT * FROM write_approvals WHERE project_database_id='d_live'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sql_text).toBe(BASE.sql);
    expect(rows[0]!.status).toBe("pending");
  });

  it("a retry finds its own request instead of opening a second", async () => {
    await resolveApproval(BASE, NO_WAIT);
    await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);

    const rows = await sql`SELECT * FROM write_approvals WHERE project_database_id='d_live'`;
    expect(rows).toHaveLength(1);
  });

  it("collects an approval granted while the agent was away", async () => {
    await resolveApproval(BASE, NO_WAIT);
    await decide(grantKeyFor(BASE), "approved", "dustin@x.test");

    const answer = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
    expect(answer).toEqual({ status: "approved", by: "dustin@x.test", note: null });
  });

  it("a grant is single-use — a second retry cannot replay it", async () => {
    await resolveApproval(BASE, NO_WAIT);
    await decide(grantKeyFor(BASE), "approved");

    const first = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
    expect(first.status).toBe("approved");

    // The claimed grant must not authorize a second execution. Asking again
    // opens a NEW pending request rather than replaying the old approval.
    const second = await resolveApproval({ ...BASE, queryId: "q3" }, NO_WAIT);
    expect(second.status).toBe("pending");
  });

  it("two concurrent retries claim one approval exactly once", async () => {
    // The property that makes the conditional UPDATE worth writing. A
    // read-then-write would let both racers see an unclaimed grant.
    await resolveApproval(BASE, NO_WAIT);
    await decide(grantKeyFor(BASE), "approved");

    const [a, b] = await Promise.all([
      resolveApproval({ ...BASE, queryId: "qa" }, NO_WAIT),
      resolveApproval({ ...BASE, queryId: "qb" }, NO_WAIT),
    ]);

    const approvals = [a, b].filter((x) => x.status === "approved");
    expect(approvals).toHaveLength(1);

    const claimed = await sql`SELECT count(*)::int AS n FROM write_approvals
                              WHERE grant_key = ${grantKeyFor(BASE)} AND claimed_at IS NOT NULL`;
    expect(claimed[0]!.n).toBe(1);
  });

  it("reports a denial with the approver's note", async () => {
    await resolveApproval(BASE, NO_WAIT);
    await decide(grantKeyFor(BASE), "denied", "tom@x.test", "use the refunds table");

    const answer = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
    expect(answer).toEqual({
      status: "denied",
      by: "tom@x.test",
      note: "use the refunds table",
    });
  });

  it("a denied statement can be asked again — the refusal does not wedge it", async () => {
    // The partial unique index is partial precisely so this works. A plain
    // unique constraint would make a denied statement permanently unaskable.
    await resolveApproval(BASE, NO_WAIT);
    await decide(grantKeyFor(BASE), "denied");
    await sql`UPDATE write_approvals SET claimed_at = now() WHERE grant_key = ${grantKeyFor(BASE)}`;

    // A fresh ask (different token ⇒ different grant) must open cleanly.
    const answer = await resolveApproval({ ...BASE, mcpTokenId: "tok_b" }, NO_WAIT);
    expect(answer.status).toBe("pending");
  });

  it("a different statement is a different grant", async () => {
    await resolveApproval(BASE, NO_WAIT);
    await decide(grantKeyFor(BASE), "approved");

    // The substitution this key exists to prevent.
    const widened = { ...BASE, sql: "UPDATE orders SET status='refunded' WHERE id<100000" };
    const answer = await resolveApproval(widened, NO_WAIT);
    expect(answer.status).toBe("pending");
  });

  it("a different agent cannot collect another agent's grant", async () => {
    await resolveApproval(BASE, NO_WAIT);
    await decide(grantKeyFor(BASE), "approved");

    const otherAgent = { ...BASE, mcpTokenId: "tok_b" };
    const answer = await resolveApproval(otherAgent, NO_WAIT);
    expect(answer.status).toBe("pending");
  });

  it("reports an expired window ONCE, then lets the agent ask again", async () => {
    // The message says "re-run it to ask again", so that has to work. An
    // earlier version returned expired forever: every retry found the same
    // settled row and answered before a new request could be opened, which made
    // the statement permanently unaskable and the message a lie.
    await resolveApproval({ ...BASE, expiresAfterSeconds: 60 }, NO_WAIT);
    await sql`UPDATE write_approvals SET expires_at = now() - interval '1 minute'
              WHERE grant_key = ${grantKeyFor(BASE)}`;

    const first = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
    expect(first.status).toBe("expired");

    const second = await resolveApproval({ ...BASE, queryId: "q3" }, NO_WAIT);
    expect(second.status).toBe("pending");

    const rows = await sql`SELECT status FROM write_approvals
                           WHERE grant_key = ${grantKeyFor(BASE)} ORDER BY created_at`;
    expect(rows.map((r) => (r as { status: string }).status)).toEqual(["expired", "pending"]);
  });

  it("concurrent retries after expiry report it once, not twice", async () => {
    await resolveApproval({ ...BASE, expiresAfterSeconds: 60 }, NO_WAIT);
    await sql`UPDATE write_approvals SET expires_at = now() - interval '1 minute'
              WHERE grant_key = ${grantKeyFor(BASE)}`;

    const [a, b] = await Promise.all([
      resolveApproval({ ...BASE, queryId: "qa" }, NO_WAIT),
      resolveApproval({ ...BASE, queryId: "qb" }, NO_WAIT),
    ]);
    expect([a, b].filter((x) => x.status === "expired")).toHaveLength(1);
  });

  it("a denial persists across retries — it does not re-page the approver", async () => {
    // Deliberately unlike expiry. A human refused THIS statement; re-running it
    // identically must keep being refused rather than opening a fresh request.
    await resolveApproval(BASE, NO_WAIT);
    await decide(grantKeyFor(BASE), "denied", "tom@x.test", "no");

    for (const q of ["q2", "q3", "q4"]) {
      const answer = await resolveApproval({ ...BASE, queryId: q }, NO_WAIT);
      expect(answer.status).toBe("denied");
    }
    const rows = await sql`SELECT count(*)::int AS n FROM write_approvals
                           WHERE grant_key = ${grantKeyFor(BASE)}`;
    expect(rows[0]!.n).toBe(1);
  });

  it("an approval that expired before being claimed is not usable", async () => {
    // Approved, then nobody ran it in time. Silence must not become a late yes.
    await resolveApproval(BASE, NO_WAIT);
    await decide(grantKeyFor(BASE), "approved");
    await sql`UPDATE write_approvals SET expires_at = now() - interval '1 minute'
              WHERE grant_key = ${grantKeyFor(BASE)}`;

    const answer = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
    expect(answer.status).not.toBe("approved");
  });

  it("the sweeper relabels stale pending rows and is idempotent", async () => {
    await resolveApproval(BASE, NO_WAIT);
    await sql`UPDATE write_approvals SET expires_at = now() - interval '1 minute'
              WHERE grant_key = ${grantKeyFor(BASE)}`;

    expect(await expireStaleApprovals("eu")).toBe(1);
    expect(await expireStaleApprovals("eu")).toBe(0);

    const rows = await sql`SELECT status FROM write_approvals WHERE grant_key = ${grantKeyFor(BASE)}`;
    expect(rows[0]!.status).toBe("expired");
  });

  it("the sweeper leaves live requests alone", async () => {
    await resolveApproval(BASE, NO_WAIT);
    expect(await expireStaleApprovals("eu")).toBe(0);
    const rows = await sql`SELECT status FROM write_approvals WHERE grant_key = ${grantKeyFor(BASE)}`;
    expect(rows[0]!.status).toBe("pending");
  });

  describe("review fixes", () => {
    async function openOne2() {
      const a = await resolveApproval(BASE, NO_WAIT);
      if (a.status !== "pending") throw new Error("expected pending");
      return a.approvalId;
    }

    it("an expired request can never be marked approved, even for an instant", async () => {
      // The deadline is IN the atomic update. Marking it approved and
      // correcting afterwards left a window where a concurrent engine poll
      // could claim the grant and execute past expiry.
      const id = await openOne2();
      await sql`UPDATE write_approvals SET expires_at = now() - interval '1 minute' WHERE id = ${id}`;

      const result = await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_named", note: null,
      });
      expect(result).toEqual({ ok: false, error: "expired" });

      // Relabelled to expired, but never through 'approved' — and with no
      // approver recorded, so no racer could have seen a claimable grant and
      // no human is credited with a decision they did not make.
      const rows = await sql`SELECT status, decided_by_user_id FROM write_approvals WHERE id = ${id}`;
      expect(rows[0]!.status).toBe("expired");
      expect(rows[0]!.decided_by_user_id).toBeNull();
    });

    it("still distinguishes already-decided from expired", async () => {
      const id = await openOne2();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "denied", userId: "u_named", note: null,
      });
      expect(
        await decideApproval({
          region: "eu", customerId: "c_live", id,
          decision: "approved", userId: "u_named", note: null,
        }),
      ).toEqual({ ok: false, error: "already_decided" });
    });

    it("a claimed grant with no EXECUTED row reports consumed, not executed", async () => {
      // claimedAt is set BEFORE the engine audits and executes, so the
      // statement can still fail in Postgres afterwards. Reporting "executed"
      // off the claim alone tells the agent a write happened when it may not
      // have.
      const id = await openOne2();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_named", note: null,
      });
      await resolveApproval({ ...BASE, queryId: "q_claim" }, NO_WAIT);

      expect(
        await checkApprovalStatus({
          region: "eu", projectId: "p_live", approvalId: id, mcpTokenId: BASE.mcpTokenId,
        }),
      ).toEqual({ status: "consumed" });

      await sql`INSERT INTO audit_events_index
                  (id, customer_id, tenant_id, region, query_id, database, ts,
                   event_type, payload, schema_version)
                VALUES ('ae_ck','c_live','t','eu','q_claim','main', now(),
                        'EXECUTED', ${sql.json({ exec_ms: 2, overhead_ms: 1, rows_affected: 1 })}, 3)`;

      expect(
        await checkApprovalStatus({
          region: "eu", projectId: "p_live", approvalId: id, mcpTokenId: BASE.mcpTokenId,
        }),
      ).toEqual({ status: "executed" });
    });

    it("an approved grant past its deadline reports expired, not approved", async () => {
      // claimSettled requires expiresAt > now, so this grant can never be
      // claimed. Saying "approved" would tell the agent to run a statement that
      // will only ever open a fresh request.
      const id = await openOne2();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_named", note: null,
      });
      await sql`UPDATE write_approvals SET expires_at = now() - interval '1 minute' WHERE id = ${id}`;

      expect(
        await checkApprovalStatus({
          region: "eu", projectId: "p_live", approvalId: id, mcpTokenId: BASE.mcpTokenId,
        }),
      ).toEqual({ status: "expired" });
    });

    it("a tokenless session can check its own tokenless request", async () => {
      // stdio and self-host carry no MCP token, and their rows store null too.
      // Rejecting on falsiness made check_approval useless for exactly the
      // sessions the pending response tells to call it.
      const anon = { ...BASE, mcpTokenId: null };
      const a = await resolveApproval(anon, NO_WAIT);
      if (a.status !== "pending") throw new Error("expected pending");

      const seen = await checkApprovalStatus({
        region: "eu", projectId: "p_live", approvalId: a.approvalId, mcpTokenId: null,
      });
      expect(seen.status).toBe("pending");

      // A tokened session still cannot see it, and vice versa.
      expect(
        await checkApprovalStatus({
          region: "eu", projectId: "p_live", approvalId: a.approvalId, mcpTokenId: "tok_a",
        }),
      ).toEqual({ status: "not_found" });
    });

    it("one agent cannot check another agent's request", async () => {
      const id = await openOne2();
      expect(
        await checkApprovalStatus({
          region: "eu", projectId: "p_live", approvalId: id, mcpTokenId: "tok_other",
        }),
      ).toEqual({ status: "not_found" });
    });
  });

  describe("deciding", () => {
    async function openOne() {
      const answer = await resolveApproval(BASE, NO_WAIT);
      if (answer.status !== "pending") throw new Error("expected pending");
      return answer.approvalId;
    }

    it("approves, and the agent's retry then collects it", async () => {
      const id = await openOne();
      expect(await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_1", note: null,
      })).toEqual({ ok: true });

      const answer = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
      expect(answer).toEqual({ status: "approved", by: "u_1", note: null });
    });

    it("denies with a note that reaches the agent", async () => {
      const id = await openOne();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "denied", userId: "u_1", note: "  use the refunds table  ",
      });
      const answer = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
      expect(answer).toEqual({
        status: "denied", by: "u_1", note: "use the refunds table",
      });
    });

    it("two approvers racing: exactly one decision lands", async () => {
      // The loser must be told, not silently overwrite the winner's note.
      const id = await openOne();
      const [a, b] = await Promise.all([
        decideApproval({ region: "eu", customerId: "c_live", id, decision: "approved", userId: "u_1", note: "yes" }),
        decideApproval({ region: "eu", customerId: "c_live", id, decision: "denied", userId: "u_2", note: "no" }),
      ]);
      const wins = [a, b].filter((r) => r.ok);
      expect(wins).toHaveLength(1);
      const loser = [a, b].find((r) => !r.ok);
      expect(loser).toEqual({ ok: false, error: "already_decided" });
    });

    it("cannot approve a request whose window already closed", async () => {
      // A late yes must not resurrect it, even before the sweeper has run.
      const id = await openOne();
      await sql`UPDATE write_approvals SET expires_at = now() - interval '1 minute' WHERE id = ${id}`;

      const result = await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_1", note: null,
      });
      expect(result).toEqual({ ok: false, error: "expired" });

      const row = await getApproval("eu", "c_live", id);
      expect(row!.status).toBe("expired");
      // And the agent must not be able to collect it.
      const answer = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
      expect(answer.status).not.toBe("approved");
    });

    it("another workspace's id reads as absent, not forbidden", async () => {
      const id = await openOne();
      expect(await getApproval("eu", "someone_else", id)).toBeNull();
      expect(await decideApproval({
        region: "eu", customerId: "someone_else", id,
        decision: "approved", userId: "u_x", note: null,
      })).toEqual({ ok: false, error: "not_found" });
    });

    it("decided rows are not hidden behind a page of pending ones", async () => {
      // The filter has to happen in SQL. Applied after LIMIT, a workspace with a
      // page's worth of newer pending requests shows an empty Decided tab while
      // decided rows sit just past the cutoff.
      const id = await openOne();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_named", note: null,
      });

      // Bury it under more pending requests than the Decided page size.
      for (let i = 0; i < 55; i++) {
        await resolveApproval({ ...BASE, sql: `UPDATE t SET x=${i} WHERE id=1` }, NO_WAIT);
      }

      const decided = await listDecidedApprovals("eu", "c_live");
      expect(decided.map((r) => r.id)).toContain(id);
    });


    it("links an approval to the execution it authorized", async () => {
      // The join that closes the loop. It keys on claimed_query_id, NOT
      // query_id: the attempt that gets HELD never executes, so joining on it
      // would silently find nothing and the queue would say "approved" forever
      // without ever saying whether the write ran.
      const id = await openOne();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_named", note: null,
      });

      // Agent retries under a NEW query id and collects.
      const collected = await resolveApproval({ ...BASE, queryId: "q_exec" }, NO_WAIT);
      expect(collected.status).toBe("approved");

      // Before the audit row lands there is no outcome to show — a real state.
      let row = await getApproval("eu", "c_live", id);
      expect(row!.executedAuditId).toBeNull();

      // The engine's EXECUTED row, indexed under the claiming attempt.
      await sql`INSERT INTO audit_events_index
                  (id, customer_id, tenant_id, region, query_id, database, ts,
                   event_type, payload, schema_version)
                VALUES ('ae_live','c_live','t','eu','q_exec','main', now(),
                        'EXECUTED', ${sql.json({ exec_ms: 3, overhead_ms: 1, rows_affected: 1284 })}, 3)`;

      row = await getApproval("eu", "c_live", id);
      expect(row!.executedAuditId).toBe("ae_live");
      expect(row!.executedRowsAffected).toBe(1284);

    });

    it("does not mistake the HELD attempt for an execution", async () => {
      // Guards the join key. An EXECUTED row under the held attempt's query_id
      // must NOT be reported as this approval's outcome — that attempt was
      // refused, so attributing an execution to it would be a false record.
      const id = await openOne();
      await sql`INSERT INTO audit_events_index
                  (id, customer_id, tenant_id, region, query_id, database, ts,
                   event_type, payload, schema_version)
                VALUES ('ae_held','c_live','t','eu',${BASE.queryId},'main', now(),
                        'EXECUTED', ${sql.json({ exec_ms: 1, overhead_ms: 1, rows_affected: 9 })}, 3)`;

      const row = await getApproval("eu", "c_live", id);
      expect(row!.executedAuditId).toBeNull();

    });

    it("the queue lists pending across projects and drops settled rows", async () => {
      const id = await openOne();
      const pending = await listPendingApprovals("eu", "c_live");
      expect(pending.map((r) => r.id)).toContain(id);
      expect(pending[0]!.database).toBe("main");
      expect(pending[0]!.sqlText).toBe(BASE.sql);

      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "denied", userId: "u_1", note: null,
      });
      expect((await listPendingApprovals("eu", "c_live")).map((r) => r.id)).not.toContain(id);
      expect((await listDecidedApprovals("eu", "c_live")).map((r) => r.id)).toContain(id);
    });

    it("names the approver for the agent, not their user id", async () => {
      // This string lands in the agent's output and then in a developer's
      // terminal. "Denied by 01J8ZQ…" is not actionable.
      const id = await openOne();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "denied", userId: "u_named", note: "use the refunds table",
      });
      const answer = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
      expect(answer).toEqual({
        status: "denied", by: "Dustin Lange", note: "use the refunds table",
      });
    });

    it("falls back to email when the account has no display name", async () => {
      const id = await openOne();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_noname", note: null,
      });
      const answer = await resolveApproval({ ...BASE, queryId: "q2" }, NO_WAIT);
      expect(answer).toEqual({ status: "approved", by: "nameless@x.test", note: null });
    });

    it("the queue shows the approver's name too", async () => {
      const id = await openOne();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_named", note: null,
      });
      const row = await getApproval("eu", "c_live", id);
      expect(row!.decidedByName).toBe("Dustin Lange");
    });

    it("a deleted approver does not drop the row from the queue", async () => {
      // LEFT join, deliberately: accountability history must survive the
      // account. The page renders "a since-deleted account" rather than 404ing.
      const id = await openOne();
      await decideApproval({
        region: "eu", customerId: "c_live", id,
        decision: "approved", userId: "u_gone", note: null,
      });
      const row = await getApproval("eu", "c_live", id);
      expect(row).not.toBeNull();
      expect(row!.decidedByUserId).toBe("u_gone");
      expect(row!.decidedByName).toBeNull();
    });
  });
});



describe("grantKeyFor", () => {
  it("is stable and statement-bound", async () => {
    const { grantKeyFor: key } = await import("../src/lib/approvals.ts");
    const base = {
      projectDatabaseId: "d1",
      sql: "DELETE FROM orders WHERE id < 100",
      intent: "cleanup",
      mcpTokenId: "tok",
    };
    expect(key(base)).toBe(key({ ...base }));
    // The widening substitution.
    expect(key({ ...base, sql: "DELETE FROM orders WHERE id < 100000" })).not.toBe(key(base));
    expect(key({ ...base, mcpTokenId: "other" })).not.toBe(key(base));
    expect(key({ ...base, projectDatabaseId: "d2" })).not.toBe(key(base));
    expect(key({ ...base, intent: "something else" })).not.toBe(key(base));
  });

  it("cannot be confused by field boundaries", async () => {
    const { grantKeyFor: key } = await import("../src/lib/approvals.ts");
    // Without length-prefixing, these two could hash identically by shifting a
    // character across the separator.
    expect(
      key({ projectDatabaseId: "ab", sql: "c", intent: "i", mcpTokenId: "t" }),
    ).not.toBe(key({ projectDatabaseId: "a", sql: "bc", intent: "i", mcpTokenId: "t" }));
  });
});
