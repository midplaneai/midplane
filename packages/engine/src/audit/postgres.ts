// Postgres audit writer.
//
// Same shape as SqliteAuditWriter. Suited to deployments that want events
// landed in a managed Postgres synchronously (with SqliteAuditWriter as a
// local fallback queue when Postgres is unavailable). Both writers share
// the AuditEvent zod schema for validation before write.

import type { Pool, PoolClient } from "pg";
import type { AuditWriter } from "./index.ts";
import { AuditEvent } from "./types.ts";
import { AuditUnavailableError } from "../errors.ts";

const INSERT_SQL = `
  INSERT INTO audit_events_index
    (id, customer_id, tenant_id, database, query_id, agent_identity, ts, event_type, payload, schema_version)
  VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7::double precision / 1000), $8, $9::jsonb, $10)
`;

export interface PostgresAuditWriterOptions {
  pool: Pool;
  customerId: string;
}

export class PostgresAuditWriter implements AuditWriter {
  constructor(private readonly opts: PostgresAuditWriterOptions) {}

  async write(event: AuditEvent): Promise<void> {
    const parsed = AuditEvent.safeParse(event);
    if (!parsed.success) {
      throw new AuditUnavailableError(
        `audit event failed schema validation: ${parsed.error.message}`,
        parsed.error,
      );
    }

    let client: PoolClient | null = null;
    try {
      client = await this.opts.pool.connect();
      await client.query(INSERT_SQL, [
        event.id,
        this.opts.customerId,
        event.tenant_id,
        event.database,
        event.query_id,
        event.agent_identity,
        event.ts,
        event.event_type,
        JSON.stringify(event.payload),
        event.schema_version,
      ]);
    } catch (err) {
      throw new AuditUnavailableError(
        `postgres write failed: ${(err as Error).message}`,
        err,
      );
    } finally {
      client?.release();
    }
  }

  async close(): Promise<void> {
    await this.opts.pool.end();
  }
}
