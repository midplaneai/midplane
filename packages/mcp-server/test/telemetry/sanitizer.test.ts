import { describe, expect, test } from "bun:test";
import { sanitize } from "../../src/telemetry/sanitizer.ts";
import type { HeartbeatEvent, StartupEvent } from "../../src/telemetry/schema.ts";

const ID = "01H8K2J9XQVWZ7PCQ3F0R2N5T8";

const validStartup: StartupEvent = {
  schema_version: 1,
  event: "startup",
  install_id: ID,
  ts: 1_730_000_000,
  version: "0.2.0",
  bun_version: "1.3.0",
  os: "linux",
  arch: "x64",
  transport: "http",
  container: true,
  ci: false,
};

const validHeartbeat: HeartbeatEvent = {
  schema_version: 1,
  event: "heartbeat",
  install_id: ID,
  ts: 1_730_086_400,
  version: "0.2.0",
  uptime_s: 86_400,
  window_s: 86_400,
  tools: { query: { calls: 10, allow: 9, deny: 1 } },
  denials_by_rule: { writes_require_approval: 1 },
  statement_types: { SELECT: 9 },
  latency_overhead_ms: { p50: 2, p95: 8, p99: 21, samples: 9 },
  exec_failures: { count: 0, by_sqlstate_class: {} },
};

describe("sanitizer", () => {
  test("valid startup passes", () => {
    const r = sanitize(validStartup);
    expect(r.ok).toBe(true);
  });

  test("valid heartbeat passes", () => {
    const r = sanitize(validHeartbeat);
    expect(r.ok).toBe(true);
  });

  test("unknown top-level field rejected (strict mode)", () => {
    const r = sanitize({ ...validStartup, evil: "extra" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("schema_violation");
  });

  test("rejects non-ULID install_id", () => {
    const r = sanitize({ ...validStartup, install_id: "not-a-ulid" });
    expect(r.ok).toBe(false);
  });

  test("rejects unknown tool name", () => {
    const r = sanitize({
      ...validHeartbeat,
      tools: { evil_tool: { calls: 1, allow: 1, deny: 0 } },
    });
    expect(r.ok).toBe(false);
  });

  test("rejects unknown policy rule", () => {
    const r = sanitize({
      ...validHeartbeat,
      denials_by_rule: { madeup_rule: 1 },
    });
    expect(r.ok).toBe(false);
  });

  test("rejects 5-char SQLSTATE in exec_failures", () => {
    const r = sanitize({
      ...validHeartbeat,
      exec_failures: { count: 1, by_sqlstate_class: { "42P01": 1 } },
    });
    expect(r.ok).toBe(false);
  });

  test("forbidden substring in version is blocked", () => {
    // Defense in depth: even if a future bug let SQL leak into a string field,
    // the substring scan should catch it.
    const r = sanitize({ ...validStartup, version: "0.2.0-SELECT" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("forbidden_substring");
  });

  test("forbidden substring in bun_version is blocked", () => {
    const r = sanitize({ ...validStartup, bun_version: "1.3.0+DROP" });
    expect(r.ok).toBe(false);
  });

  test("legitimate version strings without SQL keywords pass", () => {
    expect(sanitize({ ...validStartup, version: "0.2.0" }).ok).toBe(true);
    expect(sanitize({ ...validStartup, version: "1.0.0-rc.1" }).ok).toBe(true);
    expect(sanitize({ ...validStartup, version: "0.2.0+build.42" }).ok).toBe(true);
  });
});
