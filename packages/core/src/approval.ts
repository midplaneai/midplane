import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * The key an approval binds to: one exact statement, with one intent, on one
 * database, for one grant. Raw bytes, never normalized: `id < 100` and
 * `id < 100000` must not share an approval. Each part is length-prefixed so
 * no split of the same bytes across fields can collide.
 */
export function approvalKey(parts: {
  databaseId: string;
  sql: string;
  intent: string;
  grantId: string;
}): string {
  const fields = [parts.databaseId, parts.sql, parts.intent, parts.grantId];
  const chunks: Uint8Array[] = [];
  for (const field of fields) {
    const bytes = utf8ToBytes(field);
    chunks.push(utf8ToBytes(`${bytes.length}:`), bytes, utf8ToBytes("|"));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.length;
  }
  return bytesToHex(sha256(joined));
}
