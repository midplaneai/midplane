// Executor for a gateway database whose DSN variable isn't set.
//
// A gateway bundle names each database's connection only as an env var
// reference (`${MIDPLANE_DSN_<id>}`); the customer supplies the value. When a
// bundle adds a database before the operator has set its variable, the gateway
// still applies the bundle — a new database must not block a tightening on the
// others — and registers this one with its policy and THIS executor. Every call
// that would touch the database fails with a message naming the variable. The
// engine audits it as FAILED like any other execution error, and nothing can
// leak through a connection that doesn't exist.

import type { ExecuteContext, ExecutionResult, Executor, TxClient } from "@midplane/engine";

export class DatabaseNotConfiguredError extends Error {
  readonly code = "MIDPLANE_DSN_UNSET";
  constructor(database: string, dsnEnv: string) {
    super(
      `Database "${database}" is not configured on this gateway: set ${dsnEnv} to its connection string and restart the gateway.`,
    );
    this.name = "DatabaseNotConfiguredError";
  }
}

export class UnconfiguredExecutor implements Executor {
  constructor(
    private readonly database: string,
    private readonly dsnEnv: string,
  ) {}

  async execute(_sql: string, _ctx: ExecuteContext): Promise<ExecutionResult> {
    throw new DatabaseNotConfiguredError(this.database, this.dsnEnv);
  }

  // Implemented (and refusing) so a masked database takes the same path as a
  // configured one instead of logging a source-rewrite "fallback" warning.
  async withTransaction<T>(_ctx: ExecuteContext, _fn: (tx: TxClient) => Promise<T>): Promise<T> {
    throw new DatabaseNotConfiguredError(this.database, this.dsnEnv);
  }

  // The masking catalog resolver's entry point.
  async query(_sql: string, _params: unknown[] = []): Promise<Record<string, unknown>[]> {
    throw new DatabaseNotConfiguredError(this.database, this.dsnEnv);
  }
}
