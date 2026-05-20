// Test helpers shared across the engine test suite.
// Mocks audit/executor/credentials so policy tests run hermetically.

import type { AuditEvent } from "../src/audit/types.ts";
import type { AuditWriter } from "../src/audit/index.ts";
import type { CredentialStore } from "../src/crypto/credential-store.ts";
import type { Executor, ExecutionResult } from "../src/executor.ts";
import type { EngineContext, EngineOptions } from "../src/engine.ts";
import { Engine } from "../src/engine.ts";
import { tableAccess, type TableAccessConfig } from "../src/policy/rules/table-access.ts";
import { multiStatement } from "../src/policy/rules/multi-statement.ts";
import { tenantScope } from "../src/policy/rules/tenant-scope.ts";
import { parseError } from "../src/policy/rules/parse-error.ts";

export class MemoryAuditWriter implements AuditWriter {
  events: AuditEvent[] = [];
  failOn: AuditEvent["event_type"] | null = null;

  async write(event: AuditEvent): Promise<void> {
    if (this.failOn === event.event_type) {
      throw new Error(`forced failure on ${event.event_type}`);
    }
    this.events.push(event);
  }

  async close(): Promise<void> {}

  byType(t: AuditEvent["event_type"]) {
    return this.events.filter((e) => e.event_type === t);
  }
}

export class MockExecutor implements Executor {
  calls: Array<{ sql: string; tenant_id: string }> = [];
  result: ExecutionResult = { rows: [], rowCount: 0 };
  shouldThrow: { sqlstate: string; message: string } | null = null;

  async execute(sql: string, ctx: { tenant_id: string }): Promise<ExecutionResult> {
    this.calls.push({ sql, tenant_id: ctx.tenant_id });
    if (this.shouldThrow) {
      const err = new Error(this.shouldThrow.message) as Error & { code?: string };
      err.code = this.shouldThrow.sqlstate;
      throw err;
    }
    return this.result;
  }
}

export class StubCredentialStore implements CredentialStore {
  async resolve(_tenant_id: string): Promise<string> {
    return "postgres://stub";
  }
}

export type EngineHarness = {
  engine: Engine;
  audit: MemoryAuditWriter;
  executor: MockExecutor;
  credentials: StubCredentialStore;
};

export function makeEngine(opts: {
  enableTenantScope?: boolean;
  rules?: EngineOptions["policy"]["rules"];
  tableAccess?: TableAccessConfig;
} = {}): EngineHarness {
  const audit = new MemoryAuditWriter();
  const executor = new MockExecutor();
  const credentials = new StubCredentialStore();

  const rules =
    opts.rules ??
    [
      parseError(),
      multiStatement(),
      tableAccess(opts.tableAccess),
      tenantScope(),
    ];

  let counter = 0;
  const engine = new Engine({
    policy: { rules },
    audit,
    credentials,
    executor,
    now: () => 1_700_000_000_000,
    idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
  });

  return { engine, audit, executor, credentials };
}

export const baseCtx: EngineContext = {
  tenant_id: "42",
  agent_name: "test-agent",
  agent_version: "0.0.1",
  mcp_token_id: null,
  role: "agent_readonly",
};

export const tenantScopedCtx: EngineContext = {
  ...baseCtx,
  tenant_scope: { mappings: { users: "org_id", posts: "org_id", invoices: "customer_id" } },
};
