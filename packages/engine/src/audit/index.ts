// AuditWriter interface + re-exports.

import type { AuditEvent } from "./types.ts";

export interface AuditWriter {
  write(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

export type {
  AuditEvent,
  AttemptedPayload,
  DecidedPayload,
  ExecutedPayload,
  FailedPayload,
} from "./types.ts";
export { EventType, Decision, PolicyRule } from "./types.ts";
export { SqliteAuditWriter } from "./sqlite.ts";
export type { AuditEventRow } from "./sqlite.ts";
export { PostgresAuditWriter } from "./postgres.ts";
