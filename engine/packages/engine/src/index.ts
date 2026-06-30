// @midplane/engine — public entrypoint.

export { Engine } from "./engine.ts";
export type {
  AgentIntent,
  EngineContext,
  EngineOptions,
  MaskingConfig,
  Decision,
  DecisionPreview,
} from "./engine.ts";

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
export type { AuditEventRow } from "./audit/sqlite.ts";
export { PostgresAuditWriter } from "./audit/postgres.ts";

export type { CredentialStore } from "./crypto/credential-store.ts";
export { EnvCredentialStore } from "./crypto/credential-store.ts";

export type {
  Executor,
  ExecutionResult,
  ExecuteContext,
  ResultField,
  TxClient,
} from "./executor.ts";

export {
  applyTransform,
  isPresetName,
  isTransformKind,
  isTransformName,
  PSEUDONYMIZE_KINDS,
  ruleKind,
  TRANSFORM_KINDS,
  TRANSFORM_NAMES,
  UnknownTransformError,
} from "./masking/transforms.ts";
export type {
  Granularity,
  MaskRule,
  PseudonymizeKind,
  TransformContext,
  TransformKind,
  TransformName,
} from "./masking/transforms.ts";
export { maskResultSet } from "./masking/mask-result-set.ts";
export type {
  Catalog,
  ColumnMasks,
  MaskOutcome,
  MaskResultSetInput,
  RelInfo,
} from "./masking/mask-result-set.ts";
export { buildCatalog, buildCatalogByName, CachingCatalogResolver } from "./masking/catalog.ts";
export type {
  CatalogResolver,
  CatalogQueryFn,
  RelationRef,
  RelByName,
  ByNameCatalog,
} from "./masking/catalog.ts";
export { runSourceRewrite, setMaskSalt, MaskSaltError, MASK_SALT_GUC } from "./masking/source-rewrite.ts";
export type {
  SourceRewriter,
  RewriteOutcome,
  SourceRewriteDeps,
  SourceRewriteResult,
} from "./masking/source-rewrite.ts";

export type { Rule, RuleVerdict } from "./policy/index.ts";
export type {
  TableAccessConfig,
  TableAccessLevel,
  TableAccessResolution,
} from "./policy/index.ts";
export type { TenantScopeConfig, TenantScopeSource } from "./policy/index.ts";
export type {
  DangerousStatementConfig,
  DangerousStatementSource,
} from "./policy/index.ts";
export {
  evaluate,
  tableAccess,
  multiStatement,
  tenantScope,
  dangerousStatement,
  parseError,
  resolveTableAccessForName,
  resolveTenantColumn,
} from "./policy/index.ts";

// Dialect surface (0.6.0). `parse` / `warmup` / `ParseResult` / `PgParseTree`
// continue to be re-exported from the public API so pre-0.6.0 embedders keep
// compiling unchanged; the underlying source moved into `dialects/postgres/`.
export { parse, warmup } from "./dialects/postgres/index.ts";
export type { ParseResult, PgParseTree } from "./dialects/postgres/index.ts";
export { postgresSourceRewriter } from "./dialects/postgres/source-rewrite.ts";
export { transformToSql, quoteIdent, quoteLiteral } from "./dialects/postgres/transform-sql.ts";
export type { SqlEmit } from "./dialects/postgres/transform-sql.ts";
export {
  checkMaskSafeShape,
  shadowScan,
  MASK_SAFE_FUNCTIONS,
  MASK_SAFE_OPERATORS,
} from "./dialects/postgres/mask-safety.ts";
export type { GateOutcome } from "./dialects/postgres/mask-safety.ts";
export {
  postgresDialect,
  getDialect,
  DIALECTS,
} from "./dialects/index.ts";
export type { Dialect, DialectName } from "./dialects/index.ts";

export {
  AuditUnavailableError,
  KmsUnavailableError,
  ParserCrashedError,
} from "./errors.ts";
