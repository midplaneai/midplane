import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initTelemetry } from "../../src/telemetry/index.ts";
import { resolveInstallIdPath } from "../../src/telemetry/install-id.ts";
import type { AuditEvent } from "@midplane/engine";

function freshTmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "midplane-tel-int-")), "audit.db");
}

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = process.stderr.write;
  process.stderr.write = ((chunk: any) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return { lines, restore: () => { process.stderr.write = orig; } };
}

describe("initTelemetry — disabled", () => {
  test("returns identity audit wrapper, no install-id file, no notice", async () => {
    const dbPath = freshTmpDb();
    const cap = captureStderr();
    let handle;
    try {
      handle = initTelemetry({
        env: { MIDPLANE_TELEMETRY: "0" } as NodeJS.ProcessEnv,
        dbPath,
        version: "0.2.0",
        transport: "http",
      });
    } finally {
      cap.restore();
    }

    expect(existsSync(resolveInstallIdPath(dbPath))).toBe(false);
    expect(cap.lines.join("")).toBe("");

    const innerWrites: AuditEvent[] = [];
    const inner = { async write(e: AuditEvent) { innerWrites.push(e); }, async close() {} };
    const wrapped = handle.wrap(inner);
    expect(wrapped).toBe(inner);

    await handle.shutdown();
  });
});

describe("initTelemetry — debug", () => {
  test("startup event fires only after markReady() — boot failures are silent", async () => {
    const dbPath = freshTmpDb();

    // Phase 1: init only. The install-id is generated and the first-run
    // notice prints, but NO startup event fires until markReady().
    const cap1 = captureStderr();
    let handle;
    try {
      handle = initTelemetry({
        env: { MIDPLANE_TELEMETRY: "debug" } as NodeJS.ProcessEnv,
        dbPath,
        version: "0.2.0",
        transport: "stdio",
      });
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      cap1.restore();
    }
    const beforeReady = cap1.lines.join("");
    expect(beforeReady).toContain("[midplane] anonymous telemetry is enabled");
    expect(beforeReady).not.toContain("\"event\":\"startup\"");

    // Phase 2: markReady() — startup event must now appear.
    const cap2 = captureStderr();
    try {
      handle!.markReady();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      cap2.restore();
      if (handle) await handle.shutdown();
    }
    const afterReady = cap2.lines.join("");
    expect(afterReady).toContain("[telemetry-debug]");
    expect(afterReady).toContain("\"event\":\"startup\"");

    expect(existsSync(resolveInstallIdPath(dbPath))).toBe(true);
  });

  test("markReady is idempotent — repeat calls don't double-send", async () => {
    const dbPath = freshTmpDb();
    const cap = captureStderr();
    let handle;
    try {
      handle = initTelemetry({
        env: { MIDPLANE_TELEMETRY: "debug" } as NodeJS.ProcessEnv,
        dbPath, version: "0.2.0", transport: "http",
      });
      handle.markReady();
      handle.markReady();
      handle.markReady();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      cap.restore();
      if (handle) await handle.shutdown();
    }
    const startupLines = cap.lines.join("").match(/"event":"startup"/g) ?? [];
    expect(startupLines.length).toBe(1);
  });

  test("second run does NOT re-print the first-run notice", async () => {
    const dbPath = freshTmpDb();
    {
      const cap = captureStderr();
      const h = initTelemetry({
        env: { MIDPLANE_TELEMETRY: "debug" } as NodeJS.ProcessEnv,
        dbPath, version: "0.2.0", transport: "http",
      });
      h.markReady();
      await new Promise((r) => setTimeout(r, 10));
      cap.restore();
      await h.shutdown();
    }
    const cap = captureStderr();
    let h;
    try {
      h = initTelemetry({
        env: { MIDPLANE_TELEMETRY: "debug" } as NodeJS.ProcessEnv,
        dbPath, version: "0.2.0", transport: "http",
      });
      h.markReady();
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      cap.restore();
      if (h) await h.shutdown();
    }
    const all = cap.lines.join("");
    expect(all).not.toContain("[midplane] anonymous telemetry is enabled");
    expect(all).toContain("[telemetry-debug]");
  });

  test("heartbeat fires after configured interval; tee feeds the collector", async () => {
    const dbPath = freshTmpDb();
    const cap = captureStderr();
    let handle;
    try {
      handle = initTelemetry({
        env: {
          MIDPLANE_TELEMETRY: "debug",
          MIDPLANE_TELEMETRY_HEARTBEAT_MS: "50",
        } as NodeJS.ProcessEnv,
        dbPath,
        version: "0.2.0",
        transport: "http",
      });
      handle.markReady();
      handle.recordToolCall("query", true);
      const wrapped = handle.wrap({
        async write() {},
        async close() {},
      });
      await wrapped.write({
        id: "01TEST000000000000000000",
        query_id: "01QUERY00000000000000000",
        tenant_id: "t",
        database: "__default__",
        agent_name: "a",
        agent_version: null,
        agent_intent: null,
        intent_source: null,
        ts: Date.now(),
        schema_version: 2,
        event_type: "DECIDED",
        payload: { decision: "ALLOW", statement_type: "SELECT", tables_touched: [] },
      });

      await new Promise((r) => setTimeout(r, 200));
    } finally {
      cap.restore();
      if (handle) await handle.shutdown();
    }

    const all = cap.lines.join("");
    expect(all).toContain("\"event\":\"heartbeat\"");
    expect(all).toContain("\"SELECT\":1");
  });
});
