// HTTP approval gate — config validation and response handling.
//
// The bias under test throughout: anything short of a clear answer is
// ApprovalUnavailableError, never a denial and never permission.

import { describe, expect, test } from "bun:test";
import { ApprovalPendingError, ApprovalUnavailableError } from "@midplane/engine";
import { handleQuery } from "../src/tools/query.ts";
import type { ApprovalRequest } from "@midplane/engine";
import {
  HttpApprovalGate,
  loadApprovalGateConfig,
  type ApprovalGateConfig,
} from "../src/approval-gate.ts";

const CONFIG: ApprovalGateConfig = {
  url: "https://app.midplane.test/api/engine/approvals",
  token: "secret-token",
};

const REQ: ApprovalRequest = {
  queryId: "01QUERY",
  database: "main",
  sql: "UPDATE orders SET status='refunded' WHERE id=1",
  intent: "refund the duplicate charge",
  statementType: "UPDATE",
  tablesTouched: ["orders"],
  tenantId: "42",
  agentName: "Claude Code",
  agentVersion: "1.0.0",
  mcpTokenId: "01TOKEN",
};

function respondWith(body: unknown, init: ResponseInit = {}) {
  return async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
      ...init,
    });
}

describe("loadApprovalGateConfig", () => {
  test("returns null when approvals are simply not wired", () => {
    expect(loadApprovalGateConfig({})).toBeNull();
  });

  test("refuses to boot half-configured", () => {
    // Booting with a URL and no token would 401 every held write — an operator
    // finds out at query time instead of deploy time.
    expect(() =>
      loadApprovalGateConfig({ MIDPLANE_APPROVAL_URL: "https://x.test/a" }),
    ).toThrow(/must be set together/);
    expect(() =>
      loadApprovalGateConfig({ MIDPLANE_APPROVAL_TOKEN: "t" }),
    ).toThrow(/must be set together/);
  });

  test("rejects a non-http URL", () => {
    expect(() =>
      loadApprovalGateConfig({
        MIDPLANE_APPROVAL_URL: "file:///etc/passwd",
        MIDPLANE_APPROVAL_TOKEN: "t",
      }),
    ).toThrow(/http/);
  });

  test("accepts a complete pair and trims", () => {
    expect(
      loadApprovalGateConfig({
        MIDPLANE_APPROVAL_URL: "  https://x.test/a  ",
        MIDPLANE_APPROVAL_TOKEN: "  t  ",
      }),
    ).toEqual({ url: "https://x.test/a", token: "t" });
  });
});

describe("what the gate sends", () => {
  test("posts the statement and its context with a bearer token", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const gate = new HttpApprovalGate(CONFIG, (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ status: "approved", by: "d@x.test" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    await gate.request(REQ);

    expect(seen!.url).toBe(CONFIG.url);
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(
      "Bearer secret-token",
    );
    const body = JSON.parse(seen!.init.body as string);
    expect(body).toEqual({
      query_id: "01QUERY",
      database: "main",
      sql: "UPDATE orders SET status='refunded' WHERE id=1",
      intent: "refund the duplicate charge",
      statement_type: "UPDATE",
      tables_touched: ["orders"],
      tenant_id: "42",
      agent_name: "Claude Code",
      agent_version: "1.0.0",
      mcp_token_id: "01TOKEN",
    });
  });
});

describe("answers it understands", () => {
  test("approved", async () => {
    const gate = new HttpApprovalGate(
      CONFIG,
      respondWith({ status: "approved", by: "d@x.test", note: null }) as typeof fetch,
    );
    expect(await gate.request(REQ)).toEqual({
      status: "approved",
      by: "d@x.test",
      note: null,
    });
  });

  test("denied, carrying the approver's note", async () => {
    const gate = new HttpApprovalGate(
      CONFIG,
      respondWith({
        status: "denied",
        by: "t@x.test",
        note: "use the refunds table",
      }) as typeof fetch,
    );
    expect(await gate.request(REQ)).toEqual({
      status: "denied",
      by: "t@x.test",
      note: "use the refunds table",
    });
  });

  test("expired", async () => {
    const gate = new HttpApprovalGate(CONFIG, respondWith({ status: "expired" }) as typeof fetch);
    expect(await gate.request(REQ)).toEqual({ status: "expired" });
  });

  test("pending, with what the agent needs to return", async () => {
    const gate = new HttpApprovalGate(
      CONFIG,
      respondWith({
        status: "pending",
        approval_id: "apr_7Kq2vX",
        expires_at: 1_700_000_900_000,
        review_url: "https://app.midplane.test/approvals/apr_7Kq2vX",
      }) as typeof fetch,
    );
    expect(await gate.request(REQ)).toEqual({
      status: "pending",
      approvalId: "apr_7Kq2vX",
      expiresAt: 1_700_000_900_000,
      reviewUrl: "https://app.midplane.test/approvals/apr_7Kq2vX",
    });
  });

  test("pending without a review URL is still usable", async () => {
    const gate = new HttpApprovalGate(
      CONFIG,
      respondWith({
        status: "pending",
        approval_id: "apr_1",
        expires_at: 1_700_000_900_000,
      }) as typeof fetch,
    );
    const out = await gate.request(REQ);
    expect(out.status).toBe("pending");
  });
});

describe("everything else is unavailable, never a denial", () => {
  test("a network failure", async () => {
    const gate = new HttpApprovalGate(CONFIG, (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    await expect(gate.request(REQ)).rejects.toThrow(ApprovalUnavailableError);
  });

  test("a 500", async () => {
    const gate = new HttpApprovalGate(
      CONFIG,
      respondWith({ status: "approved" }, { status: 500 }) as typeof fetch,
    );
    await expect(gate.request(REQ)).rejects.toThrow(/HTTP 500/);
  });

  test("a 401 — a misconfigured token must not read as refusal", async () => {
    const gate = new HttpApprovalGate(
      CONFIG,
      respondWith({}, { status: 401 }) as typeof fetch,
    );
    const err = await gate.request(REQ).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalUnavailableError);
  });

  test("a non-JSON body", async () => {
    const gate = new HttpApprovalGate(CONFIG, respondWith("<html>502</html>") as typeof fetch);
    await expect(gate.request(REQ)).rejects.toThrow(ApprovalUnavailableError);
  });

  test("an unknown status", async () => {
    // A future control plane inventing a status must not be read as permission.
    const gate = new HttpApprovalGate(
      CONFIG,
      respondWith({ status: "escalated" }) as typeof fetch,
    );
    await expect(gate.request(REQ)).rejects.toThrow(ApprovalUnavailableError);
  });

  test("a pending answer missing its id or deadline", async () => {
    // Without both, the agent has nothing to come back to.
    for (const body of [
      { status: "pending", expires_at: 1 },
      { status: "pending", approval_id: "apr_1" },
    ]) {
      const gate = new HttpApprovalGate(CONFIG, respondWith(body) as typeof fetch);
      await expect(gate.request(REQ)).rejects.toThrow(ApprovalUnavailableError);
    }
  });

  test("an empty body", async () => {
    const gate = new HttpApprovalGate(CONFIG, respondWith("null") as typeof fetch);
    await expect(gate.request(REQ)).rejects.toThrow(ApprovalUnavailableError);
  });
});

describe("what survives the MCP boundary", () => {
  // The SDK turns a thrown error into its message and discards the instance, so
  // anything the agent needs must be rendered into tool output here.
  function engineThatThrows(err: unknown) {
    return {
      handle: async () => {
        throw err;
      },
    } as unknown as Parameters<typeof handleQuery>[0]["engine"];
  }

  const ARGS = { sql: "UPDATE orders SET x=1 WHERE id=1", intent: "fix" };
  const CTX = {
    tenant_id: "t",
    agent_name: null,
    agent_version: null,
    mcp_token_id: null,
  } as Parameters<typeof handleQuery>[0]["ctx"];

  test("a pending hold reaches the agent with its id, deadline and link", async () => {
    const expiresAt = 1_700_000_900_000;
    const result = await handleQuery({
      engine: engineThatThrows(
        new ApprovalPendingError("awaiting approval — re-run this exact statement.", {
          approvalId: "apr_7Kq2vX",
          expiresAt,
          reviewUrl: "https://app.midplane.test/approvals/apr_7Kq2vX",
        }),
      ),
      ctx: CTX,
      args: ARGS,
    });

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text);
    expect(body.status).toBe("awaiting_approval");
    expect(body.approval_id).toBe("apr_7Kq2vX");
    expect(body.expires_at).toBe(new Date(expiresAt).toISOString());
    expect(body.review_url).toContain("apr_7Kq2vX");
    expect(body.retryable).toBe(true);
    // Not a success: an agent treating this as done would report a write that
    // never happened.
    expect(body.allowed).toBe(false);
    expect(body.executed).toBe(false);
  });

  test("hands back the exact sql and intent needed to resume", async () => {
    // The grant is keyed on (database, sql, intent, token). Telling an agent to
    // "re-run the identical statement" while making it reconstruct that string
    // from memory is a trap: one character of drift in EITHER field silently
    // opens a second approval request instead of collecting the first.
    const result = await handleQuery({
      engine: engineThatThrows(
        new ApprovalPendingError("awaiting approval", {
          approvalId: "apr_1",
          expiresAt: 1_700_000_900_000,
        }),
      ),
      ctx: CTX,
      args: ARGS,
    });

    const body = JSON.parse(result.content[0]!.text);
    expect(body.resume.sql).toBe(ARGS.sql);
    expect(body.resume.intent).toBe(ARGS.intent);
    expect(body.resume.tool).toBe("check_approval");
    // Point the agent at the CHEAP action; re-running is what executes.
    expect(body.resume.instructions).toMatch(/poll check_approval/i);
    expect(body.resume.warning).toMatch(/byte-for-byte/i);
  });

  test("an unreachable gate reads as retryable, never as a refusal", async () => {
    const result = await handleQuery({
      engine: engineThatThrows(new ApprovalUnavailableError("control plane down")),
      ctx: CTX,
      args: ARGS,
    });

    const body = JSON.parse(result.content[0]!.text);
    expect(body.status).toBe("approval_unavailable");
    expect(body.retryable).toBe(true);
    expect(body.reason).toMatch(/nothing was denied/i);
  });

  test("other errors still bubble to the transport", async () => {
    // Infra failures (audit unavailable, KMS) keep their existing behaviour.
    await expect(
      handleQuery({
        engine: engineThatThrows(new Error("kaboom")),
        ctx: CTX,
        args: ARGS,
      }),
    ).rejects.toThrow("kaboom");
  });
});

describe("check_approval — read-only status", () => {
  test("posts the id and the caller's token to the status endpoint", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const gate = new HttpApprovalGate(CONFIG, (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ status: "expired" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch);

    await gate.check("apr_1", "tok_a");

    expect(seen!.url).toBe(`${CONFIG.url}/status`);
    // Token scoping is the whole security story: the bearer proves which
    // PROJECT the engine speaks for, not which agent inside it is asking.
    expect(JSON.parse(seen!.init.body as string)).toEqual({
      approval_id: "apr_1",
      mcp_token_id: "tok_a",
    });
  });

  test("distinguishes an unclaimed approval from one already used", async () => {
    // The difference an agent acts on: "re-run to collect" vs "you already ran
    // this, re-running opens a NEW request".
    const approved = new HttpApprovalGate(
      CONFIG,
      respondWith({ status: "approved", by: "d@x.test", note: null }) as typeof fetch,
    );
    expect(await approved.check("apr_1", "tok")).toEqual({
      status: "approved",
      by: "d@x.test",
      note: null,
    });

    const used = new HttpApprovalGate(CONFIG, respondWith({ status: "executed" }) as typeof fetch);
    expect(await used.check("apr_1", "tok")).toEqual({ status: "executed" });
  });

  test("pending carries its deadline", async () => {
    const gate = new HttpApprovalGate(
      CONFIG,
      respondWith({ status: "pending", expires_at: 1_700_000_900_000 }) as typeof fetch,
    );
    expect(await gate.check("apr_1", "tok")).toEqual({
      status: "pending",
      expiresAt: 1_700_000_900_000,
    });
  });

  test("someone else's approval reads as absent, not forbidden", async () => {
    const gate = new HttpApprovalGate(CONFIG, respondWith({ status: "not_found" }) as typeof fetch);
    expect(await gate.check("apr_1", "tok")).toEqual({ status: "not_found" });
  });

  test("an unreachable or unparseable control plane is unavailable, not a verdict", async () => {
    const dead = new HttpApprovalGate(CONFIG, (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    await expect(dead.check("apr_1", "tok")).rejects.toThrow(ApprovalUnavailableError);

    const junk = new HttpApprovalGate(CONFIG, respondWith({ status: "???" }) as typeof fetch);
    await expect(junk.check("apr_1", "tok")).rejects.toThrow(ApprovalUnavailableError);

    const pendingNoDeadline = new HttpApprovalGate(
      CONFIG,
      respondWith({ status: "pending" }) as typeof fetch,
    );
    await expect(pendingNoDeadline.check("apr_1", "tok")).rejects.toThrow(
      ApprovalUnavailableError,
    );
  });
});
