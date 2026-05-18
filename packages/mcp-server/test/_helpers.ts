// Shared test helpers for mcp-server.
//
// Mocks the engine's executor + audit so we can drive query/list_tables/
// describe_table tools end-to-end without spinning up Postgres.

import type { EngineContext, TableAccessConfig } from "@midplane/engine";
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
import type { EngineHandle, EngineRegistry } from "../src/engine-factory.ts";

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
  databaseName?: string;
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
    databaseName: opts.databaseName ?? "__default__",
    now: () => 1_700_000_000_000,
    idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
  });

  return { engine, audit, executor };
}

export const baseCtx: EngineContext = {
  tenant_id: "__self_host__",
  agent_name: "test-agent",
  agent_version: "0.0.1",
  role: "agent_readonly",
};

// Wrap a single Engine in a single-DB EngineHandle so the new buildServer
// signature works in tests that previously used the flat handle shape.
// Audit on this stub is the in-memory writer that backs the engine.
export function makeTestHandle(opts: {
  engine: Engine;
  ctxBase?: EngineContext;
  audit?: MemoryAuditWriter;
  databaseName?: string;
}): EngineHandle {
  const name = opts.databaseName ?? "__default__";
  const entry = {
    name,
    engine: opts.engine,
    ctxBase: opts.ctxBase ?? baseCtx,
    holder: {
      tableAccess: undefined as TableAccessConfig | undefined,
      tenantScope: {} as Record<string, string>,
    },
    executor: { execute: async () => ({ rows: [], rowCount: 0 }) } as Executor,
    url: "postgres://stub",
  };
  const memoryAudit = opts.audit;
  const registry: EngineRegistry = {
    get(n) {
      if (n !== name) throw new Error(`Unknown database "${n}"`);
      return entry;
    },
    has(n) {
      return n === name;
    },
    names() {
      return [name];
    },
    count() {
      return 1;
    },
    audit: memoryAudit as unknown as EngineRegistry["audit"],
    describe() {
      return [
        {
          name,
          tenant_scope_enabled: false,
          tenant_scope_column: null,
          tenant_scope_overrides: {},
          tenant_scope_exempt: [],
          table_access_default: null,
        },
      ];
    },
    async setPolicy() {
      return { applied_at: new Date().toISOString() };
    },
    async close() {},
  };
  return {
    registry,
    async close() {},
  };
}
