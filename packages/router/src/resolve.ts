import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "@midplane-cloud/db/schema";
import {
  connectionDatabases,
  connections,
  type Connection,
  type ConnectionDatabase,
} from "@midplane-cloud/db";

export type Db = PostgresJsDatabase<typeof schema>;

/** Result of resolving a token: the parent connection plus its child
 *  databases. Multi-DB rollout in 0008 splits credentials/policy out of
 *  the parent row; the proxy needs both to spawn the OSS container, so
 *  resolveByToken returns them together to avoid a second round-trip. */
export interface ResolvedConnection {
  connection: Connection;
  databases: ConnectionDatabase[];
}

// Look up a connection by its MCP token. Returns null when the token is
// unknown — caller turns that into a 404 (never 401, to avoid leaking
// existence of valid tokens via timing).
//
// Two queries on purpose: the parent shape is cheap to fetch on its own
// for callers that only need region/customer (e.g. the health endpoint),
// while a child fetch happens only for callers that need DSNs. Both run
// in the same request lifecycle so the latency cost is negligible.
export async function resolveByToken(
  db: Db,
  token: string,
): Promise<ResolvedConnection | null> {
  if (!token || token.length < 8) return null;
  const connRows = await db
    .select()
    .from(connections)
    .where(eq(connections.mcpToken, token));
  const connection = connRows[0];
  if (!connection) return null;
  const dbRows = await db
    .select()
    .from(connectionDatabases)
    .where(eq(connectionDatabases.connectionId, connection.id))
    .orderBy(asc(connectionDatabases.name));
  return { connection, databases: dbRows };
}
