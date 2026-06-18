import { describe, expect, test } from "bun:test";
import type { AuditEvent } from "@midplane/engine";
import {
  TelemetryCollector,
  TelemetryAuditWriter,
} from "../../src/telemetry/collector.ts";

const TID = "tenant-x";

function event(partial: Partial<AuditEvent> & { event_type: AuditEvent["event_type"]; payload: AuditEvent["payload"] }): AuditEvent {
  return {
    id: "01TEST000000000000000000",
    query_id: "01QUERY00000000000000000",
    tenant_id: TID,
    database: "__default__",
    agent_name: "agent-x",
    agent_version: "1.0.0",
    agent_intent: null,
    mcp_token_id: null,
    ts: 1_700_000_000_000,
    schema_version: 3,
    ...partial,
  } as AuditEvent;
}

describe("TelemetryCollector — heartbeat drain", () => {
  test("idle window returns null", () => {
    const c = new TelemetryCollector(() => 1_000);
    expect(c.drainHeartbeat()).toBeNull();
  });

  test("aggregates tool calls + ALLOW statement types", () => {
    let now = 1_000_000;
    const c = new TelemetryCollector(() => now);

    c.recordToolCall("query", true);
    c.recordToolCall("query", true);
    c.recordToolCall("query", false);

    c.onAuditEvent(event({
      event_type: "DECIDED",
      payload: { decision: "ALLOW", statement_type: "SELECT", tables_touched: [] },
    }));
    c.onAuditEvent(event({
      event_type: "DECIDED",
      payload: { decision: "ALLOW", statement_type: "INSERT", tables_touched: [] },
    }));

    now = 1_000_000 + 60_000;
    const drained = c.drainHeartbeat();
    expect(drained).not.toBeNull();
    expect(drained!.tools.query).toEqual({ calls: 3, allow: 2, deny: 1 });
    expect(drained!.statement_types).toEqual({ SELECT: 1, INSERT: 1 });
    expect(drained!.window_s).toBe(60);
  });

  test("DECIDED DENY counts policy_rule and statement_type bucket", () => {
    const c = new TelemetryCollector(() => 1_000);
    c.recordToolCall("query", false);

    c.onAuditEvent(event({
      event_type: "DECIDED",
      payload: {
        decision: "DENY",
        policy_rule: "table_access",
        reason: "denied",
        statement_type: "DELETE",
      },
    }));

    const drained = c.drainHeartbeat();
    expect(drained!.denials_by_rule).toEqual({ table_access: 1 });
    expect(drained!.statement_types).toEqual({ DELETE: 1 });
  });

  test("DECIDED DENY counts dangerous_statement (guardrail rollout is visible)", () => {
    const c = new TelemetryCollector(() => 1_000);
    c.recordToolCall("query", false);

    c.onAuditEvent(event({
      event_type: "DECIDED",
      payload: {
        decision: "DENY",
        policy_rule: "dangerous_statement",
        reason: "denied",
        statement_type: "DROP",
      },
    }));

    const drained = c.drainHeartbeat();
    expect(drained!.denials_by_rule).toEqual({ dangerous_statement: 1 });
  });

  test("unknown policy_rule names are silently dropped", () => {
    const c = new TelemetryCollector(() => 1_000);
    c.recordToolCall("query", false);

    c.onAuditEvent(event({
      event_type: "DECIDED",
      payload: {
        decision: "DENY",
        policy_rule: "future_unknown_rule",
        reason: "denied",
      },
    }));

    const drained = c.drainHeartbeat();
    expect(drained!.denials_by_rule).toEqual({});
  });

  test("FAILED records exec failure with 2-char SQLSTATE class", () => {
    const c = new TelemetryCollector(() => 1_000);
    c.recordToolCall("query", true);

    c.onAuditEvent(event({
      event_type: "FAILED",
      payload: {
        exec_ms: 5,
        overhead_ms: 1,
        error_class: "42P01",
        error_message: "relation \"foo\" does not exist",
      },
    }));

    const drained = c.drainHeartbeat();
    expect(drained!.exec_failures.count).toBe(1);
    expect(drained!.exec_failures.by_sqlstate_class).toEqual({ "42": 1 });
  });

  test("EXECUTED contributes overhead_ms to histogram", () => {
    const c = new TelemetryCollector(() => 1_000);
    c.recordToolCall("query", true);

    for (const ms of [1, 2, 5, 10, 20, 50, 100]) {
      c.onAuditEvent(event({
        event_type: "EXECUTED",
        payload: { exec_ms: ms * 10, overhead_ms: ms, rows_returned: 0 },
      }));
    }

    const drained = c.drainHeartbeat();
    expect(drained!.latency_overhead_ms.samples).toBe(7);
    expect(drained!.latency_overhead_ms.p50).toBeGreaterThan(0);
    expect(drained!.latency_overhead_ms.p95).toBeGreaterThanOrEqual(drained!.latency_overhead_ms.p50);
    expect(drained!.latency_overhead_ms.p99).toBeGreaterThanOrEqual(drained!.latency_overhead_ms.p95);
  });

  test("ATTEMPTED is ignored — sql_raw and fingerprint never recorded", () => {
    const c = new TelemetryCollector(() => 1_000);
    c.recordToolCall("query", true);

    c.onAuditEvent(event({
      event_type: "ATTEMPTED",
      payload: {
        sql_raw: "SELECT * FROM secret_table WHERE password = 'hunter2'",
        sql_fingerprint: "abcdef0123456789",
      },
    }));

    const drained = c.drainHeartbeat();
    // Heartbeat should contain no trace of the SQL or fingerprint.
    const json = JSON.stringify(drained);
    expect(json).not.toContain("secret_table");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("abcdef0123456789");
    // Substring "SELECT" is also absent (the keyword itself).
    expect(json.toUpperCase()).not.toContain("SELECT * FROM");
  });

  test("drain resets state", () => {
    const c = new TelemetryCollector(() => 1_000);
    c.recordToolCall("query", true);
    c.drainHeartbeat();
    expect(c.drainHeartbeat()).toBeNull();
  });
});

describe("TelemetryAuditWriter — tee", () => {
  test("forwards every write to inner and to collector", async () => {
    const writes: AuditEvent[] = [];
    const inner = {
      async write(e: AuditEvent) { writes.push(e); },
      async close() {},
    };
    const collector = new TelemetryCollector(() => 1_000);
    const tee = new TelemetryAuditWriter(inner, collector);

    const e = event({
      event_type: "DECIDED",
      payload: { decision: "ALLOW", statement_type: "SELECT", tables_touched: [] },
    });
    await tee.write(e);

    expect(writes).toEqual([e]);
    // Collector saw it too — drain shows the bucket.
    // (tool counter is separate; drain returns null without a tool call)
    collector.recordToolCall("query", true);
    const drained = collector.drainHeartbeat();
    expect(drained!.statement_types.SELECT).toBe(1);
  });

  test("inner write failure surfaces; collector is not invoked", async () => {
    const inner = {
      async write() { throw new Error("audit-down"); },
      async close() {},
    };
    const collector = new TelemetryCollector(() => 1_000);
    const tee = new TelemetryAuditWriter(inner, collector);

    await expect(tee.write(event({
      event_type: "ATTEMPTED",
      payload: { sql_raw: "SELECT 1", sql_fingerprint: "0000000000000000" },
    }))).rejects.toThrow("audit-down");
  });
});
