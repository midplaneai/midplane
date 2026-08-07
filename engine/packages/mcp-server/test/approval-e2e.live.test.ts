// Write approvals, end to end against real Postgres and a real HTTP gate.
//
// The unit suites stub one seam each: the gate tests stub fetch, the engine
// tests stub the gate. This one stubs nothing below the control plane — a real
// policy YAML goes through the real config loader, a real HttpApprovalGate talks
// to a real HTTP server over a real socket, and a real PgPoolExecutor writes (or
// doesn't) to a real table.
//
// It exists because "1,199 unit tests pass" and "the loop works" are different
// claims, and the previous attempt at this feature reached the first without
// ever reaching the second.
//
// Gated on APPROVALS_LIVE_PG_DSN so normal CI skips it. Run with:
//   APPROVALS_LIVE_PG_DSN=postgres://postgres@127.0.0.1:5432/postgres \
//     bun test packages/mcp-server/test/approval-e2e.live.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";

import { ApprovalPendingError, ApprovalUnavailableError } from "@midplane/engine";
import { buildEngine } from "../src/engine-factory.ts";
import { HttpApprovalGate, loadApprovalGateConfig } from "../src/approval-gate.ts";
import { loadPolicyFile, ConfigSchema } from "../src/config.ts";

const DSN = process.env.APPROVALS_LIVE_PG_DSN;
const d = DSN ? describe : describe.skip;

const CTX = {
  tenant_id: "__self_host__",
  agent_name: "e2e-agent",
  agent_version: "1.0.0",
  mcp_token_id: "01TESTTOKEN",
};

d("write approvals — live", () => {
  let client: pg.Client;
  let tmp: string;
  let server: ReturnType<typeof Bun.serve>;
  let handle: Awaited<ReturnType<typeof buildEngine>>;

  /** What the stub control plane answers next, and what it was asked. */
  let nextAnswer: Record<string, unknown> = { status: "approved", by: "d@x.test" };
  let asked: Record<string, unknown>[] = [];
  let authHeaders: (string | null)[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: DSN });
    await client.connect();
    await client.query(`
      DROP TABLE IF EXISTS approval_e2e;
      CREATE TABLE approval_e2e (id int primary key, status text);
    `);

    // Stub control plane: records the request, answers whatever the test set.
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        authHeaders.push(req.headers.get("authorization"));
        asked.push((await req.json()) as Record<string, unknown>);
        return Response.json(nextAnswer);
      },
    });

    // A real policy file through the real loader — this also proves the
    // `approvals:` block and its requires_features token parse.
    tmp = mkdtempSync(join(tmpdir(), "mp-approvals-"));
    const policyPath = join(tmp, "policy.yaml");
    writeFileSync(
      policyPath,
      [
        "databases:",
        "  - name: main",
        `    url: ${DSN}`,
        "    table_access:",
        "      default: deny",
        "      tables:",
        "        approval_e2e: read_write",
        "    guardrails:",
        "      block_unqualified_dml: true",
        "      block_ddl: true",
        "    requires_features:",
        "      - write_approvals",
        "    approvals:",
        "      writes: true",
        "",
      ].join("\n"),
    );

    const gateConfig = loadApprovalGateConfig({
      MIDPLANE_APPROVAL_URL: `http://127.0.0.1:${server.port}/approvals`,
      MIDPLANE_APPROVAL_TOKEN: "shared-secret",
    })!;

    const cfg = ConfigSchema.parse({
      policyFile: policyPath,
      dbPath: join(tmp, "audit.db"),
      transport: "stdio",
    });
    // Sanity: the loader accepted our block rather than stripping it.
    const policy = loadPolicyFile(policyPath);
    expect(policy.databases[0]!.approvals).toEqual({ writes: true });

    handle = buildEngine(cfg, { approvalGate: new HttpApprovalGate(gateConfig) });
  });

  afterAll(async () => {
    await handle?.close();
    server?.stop(true);
    await client.query("DROP TABLE IF EXISTS approval_e2e");
    await client.end();
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(async () => {
    asked = [];
    authHeaders = [];
    await client.query(
      "TRUNCATE approval_e2e; INSERT INTO approval_e2e VALUES (1,'pending'),(2,'pending')",
    );
  });

  async function statusOf(id: number): Promise<string> {
    const r = await client.query("SELECT status FROM approval_e2e WHERE id=$1", [id]);
    return r.rows[0].status;
  }

  const engine = () => handle.registry.get("main").engine;
  const WRITE = "UPDATE approval_e2e SET status='done' WHERE id=1";

  test("a read runs untouched — the gate is never called", async () => {
    const d1 = await engine().handle({ sql: "SELECT * FROM approval_e2e", ctx: CTX });
    expect(d1.allowed).toBe(true);
    expect(asked).toHaveLength(0);
  });

  test("approved: the gate is asked, then the row actually changes", async () => {
    nextAnswer = { status: "approved", by: "dustin@x.test", note: null };

    const before = await statusOf(1);
    expect(before).toBe("pending");

    const decision = await engine().handle({ sql: WRITE, ctx: CTX });

    expect(decision.allowed).toBe(true);
    expect(asked).toHaveLength(1);
    expect(authHeaders[0]).toBe("Bearer shared-secret");
    expect(asked[0]).toMatchObject({
      sql: WRITE,
      statement_type: "UPDATE",
      database: "main",
      agent_name: "e2e-agent",
      mcp_token_id: "01TESTTOKEN",
    });
    expect(asked[0]!.tables_touched).toContain("approval_e2e");

    // The point of the whole exercise.
    expect(await statusOf(1)).toBe("done");
    expect(await statusOf(2)).toBe("pending");
  });

  test("denied: nothing is written", async () => {
    nextAnswer = { status: "denied", by: "tom@x.test", note: "use the refunds table" };

    const decision = await engine().handle({ sql: WRITE, ctx: CTX });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error("unreachable");
    expect(decision.reason).toBe("approval_denied");
    expect(decision.message).toContain("use the refunds table");
    expect(await statusOf(1)).toBe("pending");
  });

  test("pending: the agent is told to come back, and NOTHING is written", async () => {
    nextAnswer = {
      status: "pending",
      approval_id: "apr_live",
      expires_at: Date.now() + 900_000,
      review_url: "https://app.midplane.test/approvals/apr_live",
    };

    const err = await engine()
      .handle({ sql: WRITE, ctx: CTX })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ApprovalPendingError);
    expect((err as ApprovalPendingError).details.approvalId).toBe("apr_live");
    expect(await statusOf(1)).toBe("pending");
  });

  test("the full round trip: held, then approved on the agent's retry", async () => {
    // What actually happens in production — the first call is held, a human
    // decides while the agent is away, the agent re-runs the identical
    // statement and collects.
    nextAnswer = {
      status: "pending",
      approval_id: "apr_live2",
      expires_at: Date.now() + 900_000,
    };
    await expect(engine().handle({ sql: WRITE, ctx: CTX })).rejects.toThrow(
      ApprovalPendingError,
    );
    expect(await statusOf(1)).toBe("pending");

    nextAnswer = { status: "approved", by: "dustin@x.test", note: null };
    const second = await engine().handle({ sql: WRITE, ctx: CTX });

    expect(second.allowed).toBe(true);
    expect(await statusOf(1)).toBe("done");
    expect(asked).toHaveLength(2);
    // Both attempts described the same statement — this is what lets the
    // control plane resolve them to one grant.
    expect(asked[0]!.sql).toBe(asked[1]!.sql);
  });

  test("an unreachable control plane refuses the write rather than running it", async () => {
    const deadGate = new HttpApprovalGate({
      url: "http://127.0.0.1:1/nope",
      token: "t",
    });
    const cfg = ConfigSchema.parse({
      policyFile: join(tmp, "policy.yaml"),
      dbPath: join(tmp, "audit2.db"),
      transport: "stdio",
    });
    const isolated = buildEngine(cfg, { approvalGate: deadGate });
    try {
      await expect(
        isolated.registry.get("main").engine.handle({ sql: WRITE, ctx: CTX }),
      ).rejects.toThrow(ApprovalUnavailableError);
      expect(await statusOf(1)).toBe("pending");
    } finally {
      await isolated.close();
    }
  });

  test("a guardrail still outranks approvals — no human is asked", async () => {
    nextAnswer = { status: "approved", by: "dustin@x.test", note: null };

    // No WHERE: block_unqualified_dml refuses it before the gate exists.
    const decision = await engine().handle({
      sql: "UPDATE approval_e2e SET status='done'",
      ctx: CTX,
    });

    expect(decision.allowed).toBe(false);
    expect(asked).toHaveLength(0);
    expect(await statusOf(1)).toBe("pending");
    expect(await statusOf(2)).toBe("pending");
  });

  test("a table the policy denies is never offered for approval", async () => {
    nextAnswer = { status: "approved", by: "dustin@x.test", note: null };
    const decision = await engine().handle({
      sql: "UPDATE pg_class SET relname='x' WHERE oid=1",
      ctx: CTX,
    });
    expect(decision.allowed).toBe(false);
    expect(asked).toHaveLength(0);
  });
});
