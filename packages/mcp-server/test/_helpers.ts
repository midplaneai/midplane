// Shared test helpers for mcp-server.
//
// Mocks the engine's executor + audit so we can drive query/list_tables/
// describe_table tools end-to-end without spinning up Postgres.

import type { EngineContext } from "@midplane/engine";
import {
  Engine,
  EnvCredentialStore,
  type AuditEvent,
  type AuditWriter,
  type Executor,
  type ExecutionResult,
  type ExecuteContext,
  parseError,
  multiStatement,
  tableAccess,
  tenantScope,
} from "@midplane/engine";

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
}

export class MockExecutor implements Executor {
  calls: Array<{ sql: string; ctx: ExecuteContext }> = [];
  result: ExecutionResult = { rows: [], rowCount: 0 };
  shouldThrow: { sqlstate: string; message: string } | null = null;

  async execute(sql: string, ctx: ExecuteContext): Promise<ExecutionResult> {
    this.calls.push({ sql, ctx });
    if (this.shouldThrow) {
      const err = new Error(this.shouldThrow.message) as Error & { code?: string };
      err.code = this.shouldThrow.sqlstate;
      throw err;
    }
    return this.result;
  }
}

export function makeTestEngine(opts: {
  audit?: MemoryAuditWriter;
  executor?: MockExecutor;
} = {}): { engine: Engine; audit: MemoryAuditWriter; executor: MockExecutor } {
  const audit = opts.audit ?? new MemoryAuditWriter();
  const executor = opts.executor ?? new MockExecutor();
  // EnvCredentialStore needs DATABASE_URL; tests can rely on defaults if set
  // or pass their own. Tests below stub it via a stub credential store when
  // the env var isn't present.
  const credentials = process.env.DATABASE_URL
    ? new EnvCredentialStore("DATABASE_URL")
    : { resolve: async () => "postgres://stub" };

  let counter = 0;
  const engine = new Engine({
    policy: {
      rules: [parseError(), multiStatement(), tableAccess(), tenantScope()],
    },
    audit,
    credentials,
    executor,
    now: () => 1_700_000_000_000,
    idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
  });

  return { engine, audit, executor };
}

export const baseCtx: EngineContext = {
  tenant_id: "__self_host__",
  agent_identity: "test-agent",
  role: "agent_readonly",
};
