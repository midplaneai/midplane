// In-process counters that drain into a HeartbeatEvent.
//
// Two ingestion paths:
//   recordToolCall(name, allowed)   — tool layer pushes per-tool counters
//   onAuditEvent(event)             — audit-tee pushes denial reasons,
//                                     statement_type buckets, latency,
//                                     and exec failures
//
// Drain semantics: drainHeartbeat() returns the current snapshot and resets
// counters atomically. If the snapshot is empty (no tool calls in the
// window), drainHeartbeat() returns null and the sender skips the post —
// no need to keep an idle install showing up daily.

import type { AuditEvent } from "@midplane/engine";
import {
  type HeartbeatEvent,
  type LatencyHistogram,
  type PolicyRuleName,
  type StatementTypeBucket,
  type ToolCounters,
  type ToolName,
  PolicyRuleName as PolicyRuleNameEnum,
  bucketStatementType,
  sqlstateClassOf,
} from "./schema.ts";

const TOOL_NAMES: readonly ToolName[] = ["query", "list_tables", "describe_table"];

const LATENCY_BUFFER_SIZE = 1024;

export class TelemetryCollector {
  private windowStart: number;

  private toolCounters: Map<ToolName, ToolCounters>;
  private denialsByRule: Map<PolicyRuleName, number>;
  private statementTypes: Map<StatementTypeBucket, number>;
  private latencies: number[];           // overhead_ms samples, circular
  private latencyCount: number;          // total observations (for samples field)
  private execFailures: { count: number; bySqlstateClass: Map<string, number> };

  constructor(private readonly now: () => number = Date.now) {
    this.windowStart = now();
    this.toolCounters = new Map();
    this.denialsByRule = new Map();
    this.statementTypes = new Map();
    this.latencies = [];
    this.latencyCount = 0;
    this.execFailures = { count: 0, bySqlstateClass: new Map() };
  }

  recordToolCall(name: ToolName, allowed: boolean): void {
    const c = this.toolCounters.get(name) ?? { calls: 0, allow: 0, deny: 0 };
    c.calls += 1;
    if (allowed) c.allow += 1;
    else c.deny += 1;
    this.toolCounters.set(name, c);
  }

  // Receives every audit event the engine produces. The collector reads
  // the locked subset of fields (rule name, statement type, exec_ms, error
  // class) and never retains the full payload. SQL text in
  // ATTEMPTED.sql_raw is intentionally ignored.
  onAuditEvent(event: AuditEvent): void {
    switch (event.event_type) {
      case "ATTEMPTED":
        // SQL text + fingerprint — never recorded.
        return;

      case "DECIDED":
        if (event.payload.decision === "ALLOW") {
          const bucket = bucketStatementType(event.payload.statement_type);
          this.statementTypes.set(bucket, (this.statementTypes.get(bucket) ?? 0) + 1);
        } else {
          const rule = event.payload.policy_rule;
          const parsed = PolicyRuleNameEnum.safeParse(rule);
          if (parsed.success) {
            this.denialsByRule.set(
              parsed.data,
              (this.denialsByRule.get(parsed.data) ?? 0) + 1,
            );
          }
          // Unknown rule names are silently dropped — the locked enum is
          // the contract with the receiver.
          if (event.payload.statement_type) {
            const bucket = bucketStatementType(event.payload.statement_type);
            this.statementTypes.set(
              bucket,
              (this.statementTypes.get(bucket) ?? 0) + 1,
            );
          }
        }
        return;

      case "EXECUTED":
        this.recordLatency(event.payload.overhead_ms);
        return;

      case "FAILED":
        this.recordLatency(event.payload.overhead_ms);
        this.execFailures.count += 1;
        // error_class can be the full 5-char SQLSTATE, "UNKNOWN", or empty.
        // Only sqlstate-shaped classes contribute to the histogram.
        const cls = sqlstateClassOf(event.payload.error_class);
        if (cls) {
          this.execFailures.bySqlstateClass.set(
            cls,
            (this.execFailures.bySqlstateClass.get(cls) ?? 0) + 1,
          );
        }
        return;
    }
  }

  private recordLatency(ms: number): void {
    this.latencyCount += 1;
    if (this.latencies.length < LATENCY_BUFFER_SIZE) {
      this.latencies.push(ms);
    } else {
      // Reservoir-style: replace a random slot once full so the buffer
      // approximates a uniform sample over the window.
      const idx = Math.floor(Math.random() * this.latencyCount);
      if (idx < LATENCY_BUFFER_SIZE) this.latencies[idx] = ms;
    }
  }

  // Returns the heartbeat payload (less the framing) or null if the window
  // had zero tool calls — caller suppresses the send in that case.
  drainHeartbeat(): {
    uptime_s: number;
    window_s: number;
    tools: Record<ToolName, ToolCounters>;
    denials_by_rule: Record<PolicyRuleName, number>;
    statement_types: Record<StatementTypeBucket, number>;
    latency_overhead_ms: LatencyHistogram;
    exec_failures: HeartbeatEvent["exec_failures"];
  } | null {
    const totalCalls = sumCalls(this.toolCounters);
    if (totalCalls === 0) {
      this.windowStart = this.now();
      return null;
    }

    const now = this.now();
    const window_s = Math.max(0, Math.floor((now - this.windowStart) / 1000));

    const tools: Partial<Record<ToolName, ToolCounters>> = {};
    for (const t of TOOL_NAMES) {
      const c = this.toolCounters.get(t);
      if (c) tools[t] = c;
    }

    const denials_by_rule: Partial<Record<PolicyRuleName, number>> = {};
    for (const [rule, n] of this.denialsByRule) denials_by_rule[rule] = n;

    const statement_types: Partial<Record<StatementTypeBucket, number>> = {};
    for (const [bucket, n] of this.statementTypes) statement_types[bucket] = n;

    const latency_overhead_ms = computeHistogram(this.latencies, this.latencyCount);

    const exec_failures = {
      count: this.execFailures.count,
      by_sqlstate_class: Object.fromEntries(this.execFailures.bySqlstateClass),
    };

    this.reset(now);

    return {
      uptime_s: 0, // process-uptime is filled in by the entrypoint; collector only knows window_s
      window_s,
      tools: tools as Record<ToolName, ToolCounters>,
      denials_by_rule: denials_by_rule as Record<PolicyRuleName, number>,
      statement_types: statement_types as Record<StatementTypeBucket, number>,
      latency_overhead_ms,
      exec_failures,
    };
  }

  private reset(now: number): void {
    this.windowStart = now;
    this.toolCounters = new Map();
    this.denialsByRule = new Map();
    this.statementTypes = new Map();
    this.latencies = [];
    this.latencyCount = 0;
    this.execFailures = { count: 0, bySqlstateClass: new Map() };
  }
}

// ─── Audit tee — wraps any AuditWriter and feeds the collector ─────────────
//
// The wrapper is transparent: every write is forwarded to the underlying
// writer first (fail-loud, since audit is critical-path), and the collector
// is fed afterwards inside a try/catch so a collector bug can never disturb
// the audit path.

import type { AuditWriter } from "@midplane/engine";

export class TelemetryAuditWriter implements AuditWriter {
  constructor(
    private readonly inner: AuditWriter,
    private readonly collector: TelemetryCollector,
  ) {}

  async write(event: AuditEvent): Promise<void> {
    await this.inner.write(event);
    try {
      this.collector.onAuditEvent(event);
    } catch {
      // Telemetry never affects the engine. Swallow.
    }
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function sumCalls(m: Map<ToolName, ToolCounters>): number {
  let total = 0;
  for (const c of m.values()) total += c.calls;
  return total;
}

function computeHistogram(samples: number[], totalSeen: number): LatencyHistogram {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, samples: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    samples: totalSeen,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return Math.max(0, Math.floor(sorted[idx]));
}
