// The query_decided mapper (lib/query-analytics.ts) — the property WHITELIST
// is the security control here (the before_send scrubber does not redact
// schema identifiers), so these tests pin both what ships AND what must not.

import { describe, expect, it } from "vitest";

import type { ContainerAuditRow } from "@midplane-cloud/router";

import { queryDecidedEvents } from "../src/lib/query-analytics.ts";

const CTX = {
  projectId: "01HXPRJ0000000000000000000",
  customerId: "01HXCUS0000000000000000000",
  region: "eu",
};

function decidedRow(
  payload: Record<string, unknown>,
  overrides: Partial<ContainerAuditRow> = {},
): ContainerAuditRow {
  return {
    id: "01HXROW0000000000000000001",
    query_id: "q-1",
    tenant_id: "t-1",
    agent_name: "claude-code",
    agent_version: "1.2.3",
    agent_intent: "find the top customers by revenue",
    intent_source: "mcp_meta",
    database: "main",
    mcp_token_id: "01HXTOK0000000000000000000",
    ts: 1_752_000_000_000,
    event_type: "DECIDED",
    payload,
    schema_version: 3,
    ...overrides,
  };
}

describe("queryDecidedEvents", () => {
  it("maps an ALLOW row: token distinctId, whitelisted props, groups, engine ts", () => {
    const events = queryDecidedEvents(
      [
        decidedRow({
          decision: "ALLOW",
          statement_type: "SELECT",
          tables_touched: ["public.users", "public.orders"],
          dialect: "postgres",
        }),
      ],
      CTX,
    );

    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.event).toBe("query_decided");
    expect(ev.distinctId).toBe("01HXTOK0000000000000000000");
    expect(ev.groups).toEqual({
      organization: CTX.customerId,
      project: CTX.projectId,
    });
    expect(ev.timestamp).toEqual(new Date(1_752_000_000_000));
    expect(ev.properties).toMatchObject({
      decision: "allow",
      policy_rule: null,
      statement_type: "SELECT",
      dialect: "postgres",
      tables_touched_count: 2,
      database: "main",
      agent_name: "claude-code",
      agent_version: "1.2.3",
      intent_source: "mcp_meta",
      audit_id: "01HXROW0000000000000000001",
      query_id: "q-1",
      project_id: CTX.projectId,
      customer_id: CTX.customerId,
      region: "eu",
    });
  });

  it("ships the categorical policy_rule on DENY — and never the free-text reason", () => {
    const events = queryDecidedEvents(
      [
        decidedRow({
          decision: "DENY",
          policy_rule: "table_access",
          reason: 'table "public.salaries" is not readable under this policy',
          statement_type: "SELECT",
          tables_touched: ["public.salaries"],
        }),
      ],
      CTX,
    );

    const props = events[0]!.properties;
    expect(props.decision).toBe("deny");
    expect(props.policy_rule).toBe("table_access");
    expect(props).not.toHaveProperty("reason");
  });

  it("never forwards name-bearing or query-content payload fields", () => {
    // A hostile/drifted payload carrying every bright-line field: the
    // whitelist must hold regardless of what the engine sends.
    const events = queryDecidedEvents(
      [
        decidedRow({
          decision: "ALLOW",
          statement_type: "SELECT",
          tables_touched: ["public.pii_table"],
          sql_raw: "SELECT ssn FROM pii_table",
          sql_fingerprint: "abc123",
          reason: "leaked",
        }),
      ],
      CTX,
    );

    const props = events[0]!.properties;
    for (const forbidden of [
      "sql_raw",
      "sql_fingerprint",
      "tables_touched",
      "reason",
      "agent_intent",
    ]) {
      expect(props).not.toHaveProperty(forbidden);
    }
    // The count survives as the only trace of tables_touched.
    expect(props.tables_touched_count).toBe(1);
  });

  it("ignores every non-DECIDED event type", () => {
    const rows: ContainerAuditRow[] = (
      ["ATTEMPTED", "EXECUTED", "FAILED", "POLICY_RELOADED"] as const
    ).map((event_type, i) =>
      decidedRow(
        { sql_raw: "SELECT 1" },
        { event_type, id: `01HXROW000000000000000000${i + 2}` },
      ),
    );
    expect(queryDecidedEvents(rows, CTX)).toHaveLength(0);
  });

  it("falls back to the customer as distinctId when the row has no token attribution", () => {
    const events = queryDecidedEvents(
      [
        decidedRow(
          { decision: "ALLOW", statement_type: "SELECT" },
          { mcp_token_id: null },
        ),
      ],
      CTX,
    );
    expect(events[0]!.distinctId).toBe(CTX.customerId);
    expect(events[0]!.properties.mcp_token_id).toBeNull();
  });

  it("drops rows whose decision shape has drifted rather than guessing", () => {
    const events = queryDecidedEvents(
      [decidedRow({ decision: "MAYBE" }), decidedRow({})],
      CTX,
    );
    expect(events).toHaveLength(0);
  });

  it("nulls policy_rule on ALLOW even when a drifted payload carries one, and coerces malformed fields", () => {
    const events = queryDecidedEvents(
      [
        decidedRow(
          {
            decision: "ALLOW",
            policy_rule: "table_access",
            reason: "stray",
            tables_touched: "not-an-array",
            statement_type: "SELECT",
          },
          { agent_name: "" },
        ),
      ],
      CTX,
    );
    const props = events[0]!.properties;
    expect(props.policy_rule).toBeNull();
    expect(props.tables_touched_count).toBeNull();
    expect(props.agent_name).toBeNull();
  });

  it("length-caps agent-controlled clientInfo strings", () => {
    const events = queryDecidedEvents(
      [
        decidedRow(
          { decision: "ALLOW", statement_type: "SELECT" },
          { agent_name: "x".repeat(500), agent_version: "y".repeat(500) },
        ),
      ],
      CTX,
    );
    expect((events[0]!.properties.agent_name as string).length).toBe(64);
    expect((events[0]!.properties.agent_version as string).length).toBe(32);
  });

  it("defaults a missing database to 'main' (legacy single-DB containers)", () => {
    const events = queryDecidedEvents(
      [
        decidedRow(
          { decision: "ALLOW", statement_type: "SELECT" },
          { database: undefined },
        ),
      ],
      CTX,
    );
    expect(events[0]!.properties.database).toBe("main");
  });
});
