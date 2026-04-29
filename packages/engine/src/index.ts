// @midplane/engine — public entrypoint.

export { Engine } from "./engine.ts";
export type { EngineContext, EngineOptions, Decision } from "./engine.ts";

export type {
  AuditWriter,
  AuditEvent,
  AttemptedPayload,
  DecidedPayload,
  ExecutedPayload,
  FailedPayload,
} from "./audit/index.ts";
export { EventType, Decision as AuditDecision, PolicyRule } from "./audit/types.ts";
export { SqliteAuditWriter } from "./audit/sqlite.ts";
export { PostgresAuditWriter } from "./audit/postgres.ts";

export type { CredentialStore } from "./crypto/credential-store.ts";
export { EnvCredentialStore } from "./crypto/credential-store.ts";

export type { Executor, ExecutionResult, ExecuteContext } from "./executor.ts";

export type { Rule, RuleVerdict } from "./policy/index.ts";
export {
  evaluate,
  writesRequireApproval,
  multiStatement,
  tenantScope,
  parseError,
} from "./policy/index.ts";

export { parse, warmup } from "./parser/parse.ts";
export type { ParseResult, PgParseTree } from "./parser/parse.ts";

export {
  AuditUnavailableError,
  KmsUnavailableError,
  ParserCrashedError,
} from "./errors.ts";
