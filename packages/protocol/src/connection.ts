// Why a connection to a database failed, in words, from the code alone: a
// gateway reports codes, never Postgres' message, which can name roles and
// hosts. One table for the gateway's prompts and the cloud's pages.

const SENTENCES: ReadonlyMap<string, string> = new Map([
  ["ECONNREFUSED", "connection refused"],
  ["ENOTFOUND", "host not found"],
  ["EAI_AGAIN", "host not found"],
  ["ETIMEDOUT", "connection timed out"],
  ["TIMEOUT", "connection timed out"],
  ["28P01", "password authentication failed"],
  ["28000", "the server refused this role or host (pg_hba.conf)"],
  ["3D000", "database does not exist"],
  ["42501", "permission denied"],
  ["57P03", "Postgres is starting up or shutting down"],
]);

/**
 * A SQLSTATE or Node error code in words; one without words is
 * "failed (code)", and no code at all is "failed".
 */
export function connectionErrorSentence(code: string | null): string {
  if (code === null) return "failed";
  return SENTENCES.get(code) ?? `failed (${code})`;
}

/** The words and the code: "password authentication failed (28P01)". */
export function connectionErrorLine(code: string | null): string {
  const words = code === null ? undefined : SENTENCES.get(code);
  return words ? `${words} (${code})` : connectionErrorSentence(code);
}
