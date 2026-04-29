// Executor interface — the "execute" stage of the locked pipeline.
//
// In production the executor is built from a CredentialStore (pg.Pool keyed
// by tenant). For tests, a mock executor returns canned rows or throws.
//
// We DI the executor explicitly (rather than inline pg) so the engine has
// no hard dependency on pg in unit tests, and so cloud's executor
// (with read-replica routing, in-region pooling, etc.) can drop in cleanly.

export interface ExecutionResult {
  rows: unknown[];
  rowCount: number;
}

export interface ExecuteContext {
  tenant_id: string;
  agent_identity: string | null;
}

export interface Executor {
  execute(sql: string, ctx: ExecuteContext): Promise<ExecutionResult>;
}
