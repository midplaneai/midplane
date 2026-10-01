// @midplane/core: the pure policy engine. One statement plus context in, one
// verdict out: parse, resolve, classify, decide, rewrite. No I/O, no clock, no
// randomness; the gateway enforces the result and the cloud simulates with it.

export { approvalKey } from "./approval.ts";
export { SEARCH_PATH } from "./catalog.ts";
export { accessLevel } from "./decide.ts";
export {
  type ColumnMask,
  maskLookup,
  unreviewedColumns,
  type VisibleRelation,
  visibleRelations,
} from "./describe.ts";
export { evaluate } from "./evaluate.ts";
export { MASK_SALT_SETTING } from "./masks.ts";
export { loadParser, MAX_SQL_BYTES } from "./parse.ts";
export {
  classifyColumn,
  type ExposureSuggestion,
  exposureScan,
  type PiiCategory,
  type PiiConfidence,
  type PiiMatch,
} from "./pii.ts";
export {
  CORE_FEATURES,
  type PolicyValidation,
  requiredFeatures,
  validatePolicy,
} from "./policy.ts";
export {
  catalogNames,
  REDACTED_STRING,
  type RedactedCatalog,
  type RedactedDefinition,
  type RedactedStatement,
  redactCatalog,
  redactDefinition,
  redactStatement,
  unredactedDefinitions,
  unredactedStatement,
  type WithheldDefinition,
  type WithheldReason,
  withheldViews,
} from "./redact.ts";
export { normalizeStatement } from "./rewrite.ts";
export type {
  BaseColumn,
  Effects,
  EvaluateInput,
  Evaluation,
  ExecutionPlan,
  Preview,
  ResolvedColumn,
  TaintSource,
} from "./types.ts";
