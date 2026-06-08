// Unit coverage for the audit export serializer (pure). Asserts the CSV
// contract (stable header, escaping, formula-injection guard) and the
// query-vs-event row shaping.

import { describe, expect, it } from "vitest";

import type { AuditQueryListRow } from "../src/lib/audit.ts";
import {
  recordsToCsv,
  recordsToJson,
  toExportRecords,
} from "../src/lib/audit-export.ts";

function row(partial: Partial<AuditQueryListRow>): AuditQueryListRow {
  return {
    queryId: "q-1",
    attemptedEventId: "att-1",
    headEventId: "head-1",
    startedAt: new Date("2026-06-08T08:59:44.000Z"),
    lastTs: new Date("2026-06-08T08:59:45.000Z"),
    tenantId: "tenant_1",
    database: "main",
    agentName: "claude-code",
    agentVersion: "2.1.165",
    agentIntent: "count customers",
    intentSource: "mcp_meta",
    sqlRaw: "SELECT count(*) FROM customers",
    sqlFingerprint: "select count(*) from customers",
    decision: "allow",
    decisionReason: null,
    execMs: 59,
    status: "ALLOWED",
    policyPayload: null,
    ...partial,
  };
}

const summarize = (r: AuditQueryListRow) => `EVT:${r.status}`;

describe("toExportRecords", () => {
  it("shapes a query row with kind + sql, empty event", () => {
    const [rec] = toExportRecords([row({})], summarize);
    expect(rec!.time).toBe("2026-06-08T08:59:44.000Z");
    expect(rec!.status).toBe("ALLOWED");
    expect(rec!.kind).toBe("read");
    expect(rec!.sql).toBe("SELECT count(*) FROM customers");
    expect(rec!.duration_ms).toBe("59");
    expect(rec!.event).toBe("");
    expect(rec!.query_id).toBe("q-1");
  });

  it("shapes an event row with summary, empty sql + kind", () => {
    const [rec] = toExportRecords(
      [
        row({
          queryId: null,
          status: "TOKEN_REVOKED",
          sqlRaw: null,
          sqlFingerprint: null,
          execMs: null,
          agentName: null,
          policyPayload: { reason: "leaked" },
        }),
      ],
      summarize,
    );
    expect(rec!.kind).toBe("");
    expect(rec!.sql).toBe("");
    expect(rec!.event).toBe("EVT:TOKEN_REVOKED");
    expect(rec!.duration_ms).toBe("");
    expect(rec!.query_id).toBe("");
  });
});

describe("recordsToCsv", () => {
  it("emits a stable header row", () => {
    const csv = recordsToCsv(toExportRecords([row({})], summarize));
    const header = csv.split("\r\n")[0];
    expect(header).toBe(
      "time,status,kind,agent,agent_version,intent,intent_source,database,tenant_id,decision,decision_reason,duration_ms,query_id,sql,sql_fingerprint,event",
    );
  });

  it("quotes + escapes cells with commas, quotes, and newlines", () => {
    const csv = recordsToCsv(
      toExportRecords(
        [row({ sqlRaw: 'SELECT \'a,b\', "c"\nFROM t' })],
        summarize,
      ),
    );
    // Embedded quotes doubled, whole field wrapped in quotes.
    expect(csv).toContain('"SELECT \'a,b\', ""c""\nFROM t"');
  });

  it("neutralizes spreadsheet formula injection with a leading quote", () => {
    const csv = recordsToCsv(
      toExportRecords([row({ sqlRaw: "=cmd()|' /C calc'" })], summarize),
    );
    // Leading = is prefixed with ' so a spreadsheet won't evaluate it; the
    // field also contains a comma so it's quoted.
    expect(csv).toContain("'=cmd()");
  });

  it("ends every line with CRLF", () => {
    const csv = recordsToCsv(toExportRecords([row({})], summarize));
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n").filter((l) => l.length > 0)).toHaveLength(2);
  });
});

describe("recordsToJson", () => {
  it("returns a parseable array of records with the column keys", () => {
    const json = recordsToJson(toExportRecords([row({})], summarize));
    const parsed = JSON.parse(json) as Array<Record<string, string>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.status).toBe("ALLOWED");
    expect(parsed[0]!.kind).toBe("read");
  });
});
