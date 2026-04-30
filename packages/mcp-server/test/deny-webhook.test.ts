// Tests for the MIDPLANE_DENY_WEBHOOK wrapper.

import { describe, expect, test } from "bun:test";
import type { AuditEvent, AuditWriter } from "@midplane/engine";
import {
  DenyWebhookAuditWriter,
  createHttpPoster,
  loadDenyWebhookConfig,
  type DenyWebhookPayload,
  type Poster,
} from "../src/deny-webhook.ts";

class MemoryWriter implements AuditWriter {
  events: AuditEvent[] = [];
  closed = false;
  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class CapturingPoster implements Poster {
  posts: DenyWebhookPayload[] = [];
  shouldThrow = false;
  async post(payload: DenyWebhookPayload): Promise<void> {
    if (this.shouldThrow) throw new Error("network down");
    this.posts.push(payload);
  }
}

function attempted(opts: {
  query_id: string;
  sql_raw: string;
  id?: string;
  ts?: number;
}): AuditEvent {
  return {
    id: opts.id ?? "01ATTEMPTED00",
    query_id: opts.query_id,
    tenant_id: "tenant-1",
    agent_identity: "agent-x",
    ts: opts.ts ?? 1_700_000_000_000,
    schema_version: 1,
    event_type: "ATTEMPTED",
    payload: {
      sql_raw: opts.sql_raw,
      sql_fingerprint: "0123456789abcdef",
    },
  };
}

function decidedDeny(opts: {
  query_id: string;
  policy_rule: string;
  reason?: string;
  statement_type?: string;
  tables_touched?: string[];
  id?: string;
  ts?: number;
}): AuditEvent {
  return {
    id: opts.id ?? "01DECIDED0001",
    query_id: opts.query_id,
    tenant_id: "tenant-1",
    agent_identity: "agent-x",
    ts: opts.ts ?? 1_700_000_000_000,
    schema_version: 1,
    event_type: "DECIDED",
    payload: {
      decision: "DENY",
      policy_rule: opts.policy_rule,
      reason: opts.reason ?? "denied",
      statement_type: opts.statement_type,
      tables_touched: opts.tables_touched,
    },
  };
}

function decidedAllow(opts: {
  query_id: string;
  statement_type?: string;
  tables_touched?: string[];
}): AuditEvent {
  return {
    id: "01DECIDEDALLOW",
    query_id: opts.query_id,
    tenant_id: "tenant-1",
    agent_identity: "agent-x",
    ts: 1_700_000_000_000,
    schema_version: 1,
    event_type: "DECIDED",
    payload: {
      decision: "ALLOW",
      statement_type: opts.statement_type ?? "SELECT",
      tables_touched: opts.tables_touched ?? [],
    },
  };
}

describe("loadDenyWebhookConfig", () => {
  test("returns null when env var is unset or empty", () => {
    expect(loadDenyWebhookConfig({})).toBeNull();
    expect(loadDenyWebhookConfig({ MIDPLANE_DENY_WEBHOOK: "" })).toBeNull();
    expect(loadDenyWebhookConfig({ MIDPLANE_DENY_WEBHOOK: "   " })).toBeNull();
  });

  test("rejects non-http(s) URLs", () => {
    expect(() =>
      loadDenyWebhookConfig({ MIDPLANE_DENY_WEBHOOK: "file:///etc/passwd" }),
    ).toThrow(/http/);
    expect(() =>
      loadDenyWebhookConfig({ MIDPLANE_DENY_WEBHOOK: "javascript:alert(1)" }),
    ).toThrow(/http/);
    expect(() =>
      loadDenyWebhookConfig({ MIDPLANE_DENY_WEBHOOK: "hooks.slack.com/x" }),
    ).toThrow(/http/);
  });

  test("accepts http and https", () => {
    const a = loadDenyWebhookConfig({
      MIDPLANE_DENY_WEBHOOK: "https://hooks.slack.com/x",
    });
    expect(a?.url).toBe("https://hooks.slack.com/x");
    expect(a?.rules).toBeUndefined();

    const b = loadDenyWebhookConfig({
      MIDPLANE_DENY_WEBHOOK: "http://localhost:9000/hook",
    });
    expect(b?.url).toBe("http://localhost:9000/hook");
  });

  test("parses MIDPLANE_DENY_WEBHOOK_RULES into a Set", () => {
    const c = loadDenyWebhookConfig({
      MIDPLANE_DENY_WEBHOOK: "https://hooks.slack.com/x",
      MIDPLANE_DENY_WEBHOOK_RULES: "table_access, multi_statement",
    });
    expect(c?.rules).toBeInstanceOf(Set);
    expect([...c!.rules!].sort()).toEqual([
      "multi_statement",
      "table_access",
    ]);
  });

  test("empty rules string is treated as 'all rules'", () => {
    const c = loadDenyWebhookConfig({
      MIDPLANE_DENY_WEBHOOK: "https://hooks.slack.com/x",
      MIDPLANE_DENY_WEBHOOK_RULES: "  ,  ,  ",
    });
    expect(c?.rules).toBeUndefined();
  });
});

describe("DenyWebhookAuditWriter", () => {
  test("forwards every write to the inner writer (transparent tee)", async () => {
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      poster,
    );
    const ev = attempted({ query_id: "q1", sql_raw: "SELECT 1" });
    await w.write(ev);
    expect(inner.events).toEqual([ev]);
  });

  test("close() chains to the inner writer", async () => {
    const inner = new MemoryWriter();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      new CapturingPoster(),
    );
    await w.close();
    expect(inner.closed).toBe(true);
  });

  test("ALLOW decisions never fire the webhook", async () => {
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      poster,
    );
    await w.write(attempted({ query_id: "q1", sql_raw: "SELECT 1" }));
    await w.write(decidedAllow({ query_id: "q1" }));
    await Promise.resolve();
    expect(poster.posts).toHaveLength(0);
  });

  test("DENY decisions fire a webhook with the matching ATTEMPTED SQL preview", async () => {
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      poster,
    );

    await w.write(
      attempted({ query_id: "q1", sql_raw: "DELETE FROM users" }),
    );
    await w.write(
      decidedDeny({
        query_id: "q1",
        policy_rule: "table_access",
        reason: "writes denied",
        statement_type: "DELETE",
        tables_touched: ["public.users"],
      }),
    );
    // Posts are fire-and-forget; flush the microtask queue.
    await new Promise((r) => setTimeout(r, 0));

    expect(poster.posts).toHaveLength(1);
    const p = poster.posts[0];
    expect(p.event).toBe("denial");
    expect(p.schema_version).toBe(1);
    expect(p.query_id).toBe("q1");
    expect(p.tenant_id).toBe("tenant-1");
    expect(p.agent_identity).toBe("agent-x");
    expect(p.policy_rule).toBe("table_access");
    expect(p.reason).toBe("writes denied");
    expect(p.statement_type).toBe("DELETE");
    expect(p.tables_touched).toEqual(["public.users"]);
    expect(p.sql_preview).toBe("DELETE FROM users");
    expect(p.sql_truncated).toBe(false);
  });

  test("rules filter suppresses denials whose policy_rule is not listed", async () => {
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x", rules: new Set(["table_access"]) },
      poster,
    );

    await w.write(attempted({ query_id: "q1", sql_raw: "SELECT 1; SELECT 2" }));
    await w.write(
      decidedDeny({ query_id: "q1", policy_rule: "multi_statement" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(poster.posts).toHaveLength(0);

    await w.write(attempted({ query_id: "q2", sql_raw: "DELETE FROM x" }));
    await w.write(
      decidedDeny({ query_id: "q2", policy_rule: "table_access" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0].policy_rule).toBe("table_access");
  });

  test("SQL preview is truncated at 1024 chars and flagged", async () => {
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      poster,
    );

    const longSql = "SELECT '" + "a".repeat(2000) + "'";
    await w.write(attempted({ query_id: "q1", sql_raw: longSql }));
    await w.write(
      decidedDeny({ query_id: "q1", policy_rule: "table_access" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0].sql_preview).toHaveLength(1024);
    expect(poster.posts[0].sql_preview).toBe(longSql.slice(0, 1024));
    expect(poster.posts[0].sql_truncated).toBe(true);
  });

  test("SQL of exactly 1024 chars is preserved and NOT flagged as truncated", async () => {
    // Regression: deriving sql_truncated from preview.length === 1024 marks
    // boundary-length queries as truncated even though the full text was
    // captured. Receivers consuming the flag would mis-handle these.
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      poster,
    );

    const exactSql = "x".repeat(1024);
    expect(exactSql).toHaveLength(1024);

    await w.write(attempted({ query_id: "q1", sql_raw: exactSql }));
    await w.write(
      decidedDeny({ query_id: "q1", policy_rule: "table_access" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0].sql_preview).toBe(exactSql);
    expect(poster.posts[0].sql_preview).toHaveLength(1024);
    expect(poster.posts[0].sql_truncated).toBe(false);
  });

  test("DENY without a matching ATTEMPTED still fires (sql_preview is empty)", async () => {
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      poster,
    );
    await w.write(
      decidedDeny({ query_id: "orphan", policy_rule: "parse_error" }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0].sql_preview).toBe("");
    expect(poster.posts[0].sql_truncated).toBe(false);
  });

  test("poster failure does not break or block the audit write", async () => {
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    poster.shouldThrow = true;
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      poster,
    );

    await w.write(attempted({ query_id: "q1", sql_raw: "DELETE FROM x" }));
    // The DECIDED write must not throw even though the poster will reject.
    await w.write(
      decidedDeny({ query_id: "q1", policy_rule: "table_access" }),
    );

    expect(inner.events).toHaveLength(2);
  });

  test("ALLOW clears the pending SQL buffer (no leak across reused query_ids)", async () => {
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      poster,
    );

    // q1: ATTEMPTED then ALLOW → pending entry cleared.
    await w.write(attempted({ query_id: "q1", sql_raw: "SELECT 1" }));
    await w.write(decidedAllow({ query_id: "q1" }));

    // Reusing q1 with a DENY but no ATTEMPTED would have leaked the prior SQL.
    await w.write(
      decidedDeny({ query_id: "q1", policy_rule: "parse_error" }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(poster.posts).toHaveLength(1);
    expect(poster.posts[0].sql_preview).toBe("");
  });

  test("buffer cap drops oldest pending SQL beyond 256 entries", async () => {
    const inner = new MemoryWriter();
    const poster = new CapturingPoster();
    const w = new DenyWebhookAuditWriter(
      inner,
      { url: "https://x" },
      poster,
    );

    // Buffer 257 ATTEMPTED rows. The first one (q0) gets evicted.
    for (let i = 0; i < 257; i++) {
      await w.write(attempted({ query_id: `q${i}`, sql_raw: `SELECT ${i}` }));
    }

    // q0 should be gone — fire DENY for it and confirm sql_preview is empty.
    await w.write(
      decidedDeny({ query_id: "q0", policy_rule: "table_access" }),
    );
    // q256 should still be there with its SQL.
    await w.write(
      decidedDeny({
        query_id: "q256",
        policy_rule: "table_access",
      }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(poster.posts).toHaveLength(2);
    expect(poster.posts[0].sql_preview).toBe("");
    expect(poster.posts[1].sql_preview).toBe("SELECT 256");
  });
});

describe("createHttpPoster", () => {
  const samplePayload: DenyWebhookPayload = {
    event: "denial",
    schema_version: 1,
    ts: 1_700_000_000_000,
    query_id: "q1",
    audit_id: "a1",
    tenant_id: "t",
    agent_identity: null,
    policy_rule: "table_access",
    reason: "denied",
    statement_type: null,
    tables_touched: [],
    sql_preview: "",
    sql_truncated: false,
  };

  test("4xx response is logged as a warning, not silently dropped", async () => {
    // Regression: receivers like Slack reject malformed payloads with 400.
    // Previously the poster only watched for thrown exceptions, so HTTP
    // errors were treated as success and the operator never noticed their
    // integration was broken.
    const warns: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
    const fakeLog = {
      warn: (ctx: Record<string, unknown>, msg: string) =>
        warns.push({ ctx, msg }),
    };

    let fetchCalls = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("invalid_payload", { status: 400 });
    }) as typeof fetch;

    try {
      const poster = createHttpPoster("https://example.com/hook", fakeLog);
      await poster.post(samplePayload); // must not throw
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(fetchCalls).toBe(1);
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain("non-2xx");
    expect(warns[0].ctx.status).toBe(400);
    expect(warns[0].ctx.rule).toBe("table_access");
  });

  test("5xx response is logged as a warning", async () => {
    const warns: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
    const fakeLog = {
      warn: (ctx: Record<string, unknown>, msg: string) =>
        warns.push({ ctx, msg }),
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 503 })) as typeof fetch;

    try {
      const poster = createHttpPoster("https://example.com/hook", fakeLog);
      await poster.post(samplePayload);
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(warns).toHaveLength(1);
    expect(warns[0].ctx.status).toBe(503);
  });

  test("2xx response does not log a warning", async () => {
    const warns: unknown[] = [];
    const fakeLog = {
      warn: (...args: unknown[]) => warns.push(args),
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;

    try {
      const poster = createHttpPoster("https://example.com/hook", fakeLog);
      await poster.post(samplePayload);
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(warns).toHaveLength(0);
  });

  test("network error path still logs a warning", async () => {
    const warns: Array<{ ctx: Record<string, unknown>; msg: string }> = [];
    const fakeLog = {
      warn: (ctx: Record<string, unknown>, msg: string) =>
        warns.push({ ctx, msg }),
    };

    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("dns error");
    }) as typeof fetch;

    try {
      const poster = createHttpPoster("https://example.com/hook", fakeLog);
      await poster.post(samplePayload); // must not throw
    } finally {
      globalThis.fetch = origFetch;
    }

    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain("post failed");
    expect(warns[0].ctx.err).toBe("dns error");
  });
});
