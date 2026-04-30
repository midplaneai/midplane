import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "@midplane-cloud/db/schema";
import { connections, type Connection } from "@midplane-cloud/db";

export type Db = PostgresJsDatabase<typeof schema>;

// Look up a connection by its MCP token. Returns null when the token is
// unknown — caller turns that into a 404 (never 401, to avoid leaking
// existence of valid tokens via timing).
export async function resolveByToken(
  db: Db,
  token: string,
): Promise<Connection | null> {
  if (!token || token.length < 8) return null;
  const rows = await db
    .select()
    .from(connections)
    .where(eq(connections.mcpToken, token));
  return rows[0] ?? null;
}
