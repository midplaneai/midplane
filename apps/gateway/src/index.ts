// midplane: the gateway. An MCP server, an OAuth resource server and a guarded
// Postgres client that enforces @midplane/core verdicts next to the database.

export { AuditFileReader, LocalAuditLog } from "./audit.ts";
export {
  exportAudit,
  readCheckpoints,
  verifyAuditExport,
  verifyAuditFile,
} from "./audit-cli.ts";
export { generateSigningKey, mintToken, TokenVerifier } from "./auth.ts";
export { assessBundle, verifyBundle } from "./bundle.ts";
export { introspect } from "./catalog.ts";
export {
  ConfigError,
  type LinkedConfig,
  type LocalConfig,
  loadConfig,
  loadLinkedConfig,
  parseConfig,
  parseLinkedConfig,
} from "./config.ts";
export {
  DatabaseExecutor,
  ExecutionError,
  SESSION_SEARCH_PATH,
} from "./executor.ts";
export { type Enforcement, Gateway } from "./gateway.ts";
export { buildApp, MCP_PATH } from "./http.ts";
export {
  type Enrollment,
  EnrollmentError,
  enroll,
  enrollmentPin,
  GATEWAY_FEATURES,
  type GatewayIdentity,
} from "./identity.ts";
export { LinkClient } from "./link.ts";
export { openPrompter, PromptClosed, type Prompter } from "./prompt.ts";
export {
  enrollOnly,
  type RunningGateway,
  startLinked,
  startLocal,
} from "./server.ts";
export {
  runSetup,
  SetupError,
  type SetupFlags,
  type SetupIO,
  type SetupResult,
} from "./setup.ts";
