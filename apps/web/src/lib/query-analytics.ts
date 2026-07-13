// Maps drained audit rows → `query_decided` PostHog events (launch-analytics
// spec §4). Pure so the whitelist is unit-testable without an Indexer.
//
// This is the core-value product event: the live agent path's ALLOW/DENY only
// ever surfaces on the control plane via the audit Indexer (the MCP proxy is
// an opaque byte-stream), so mcp-proxy.ts wires this into Indexer.onIndexed.
//
// PROPERTY WHITELIST IS THE SECURITY CONTROL. The DECIDED payload carries
// `tables_touched` (schema-qualified table names) and a free-text `reason`
// that can embed them; sibling rows carry `sql_raw`/`sql_fingerprint` and
// `agent_intent`. The before_send scrubber does NOT redact schema
// identifiers, so nothing below may forward payload fields wholesale — every
// property is picked by name, and name-bearing fields are reduced to counts
// or dropped. Additions here need the same scrutiny.
//
// Accepted exceptions (spec §4, launch-analytics-and-error-spec.md):
//   - `database` ships verbatim: it's the customer-chosen agent-facing DB
//     ALIAS ("main", "analytics") — a deliberate whitelist entry for
//     per-database segmentation, not a table/column identifier.
//   - `agent_name`/`agent_version` ship (they're the audit dashboard's
//     grouping keys) but are agent-controlled free text from MCP
//     clientInfo, so they are LENGTH-CAPPED here — the one field with an
//     engine-side cap is agent_intent, which never ships at all.

import type { ContainerAuditRow } from "@midplane-cloud/router";

export interface QueryDecidedEvent {
  distinctId: string;
  event: "query_decided";
  properties: Record<string, string | number | boolean | null>;
  groups: { organization: string; project: string };
  /** Engine-side decision time — the drain runs ~5s behind, so the capture
   *  must not let PostHog stamp ingest time. */
  timestamp: Date;
}

export interface QueryDecidedContext {
  projectId: string;
  customerId: string;
  region: string;
}

function str(v: unknown, maxLen = 256): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, maxLen) : null;
}

/** DECIDED rows → events; every other event type is ignored (EXECUTED/FAILED
 *  mirrors are a P1 follow-up). distinctId is the per-agent token id —
 *  uniform across PAT and OAuth (OAuth mints an attribution token) — falling
 *  back to the org for pre-lockstep sessions with no token attribution. */
export function queryDecidedEvents(
  rows: readonly ContainerAuditRow[],
  ctx: QueryDecidedContext,
): QueryDecidedEvent[] {
  const events: QueryDecidedEvent[] = [];
  for (const row of rows) {
    if (row.event_type !== "DECIDED") continue;
    const payload = row.payload;
    const decision = str(payload.decision)?.toLowerCase();
    // Contract drift guard: an unrecognized decision shape is dropped, not
    // guessed at — the row itself is already durable in the audit index.
    if (decision !== "allow" && decision !== "deny") continue;

    // Length-capped like every engine-influenced string: the row crosses a
    // trust boundary (a hostile container could forge an oversized value),
    // and unlike the DB insert there's no FK guard normalizing it here.
    const tokenId = str(row.mcp_token_id, 64);

    events.push({
      distinctId: tokenId ?? ctx.customerId,
      event: "query_decided",
      properties: {
        // The distinctId is an agent token, not a human — person-profile
        // processing off, or every token mints a junk person at the
        // system's highest event volume. Group analytics is unaffected.
        $process_person_profile: false,
        decision,
        // Categorical rule name (DENY only), e.g. "table_access" — safe;
        // the free-text `reason` alongside it is not.
        policy_rule: decision === "deny" ? str(payload.policy_rule) : null,
        statement_type: str(payload.statement_type),
        dialect: str(payload.dialect),
        tables_touched_count: Array.isArray(payload.tables_touched)
          ? payload.tables_touched.length
          : null,
        database: str(row.database, 64) ?? "main",
        agent_name: str(row.agent_name, 64),
        agent_version: str(row.agent_version, 32),
        intent_source: str(row.intent_source),
        audit_id: row.id,
        query_id: row.query_id,
        mcp_token_id: tokenId,
        project_id: ctx.projectId,
        customer_id: ctx.customerId,
        region: ctx.region,
      },
      groups: { organization: ctx.customerId, project: ctx.projectId },
      timestamp: new Date(row.ts),
    });
  }
  return events;
}
