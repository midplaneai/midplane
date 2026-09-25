// Bounded response reads for the engine's outbound calls (the gateway link and
// the approval gate). A peer that streams without end — or a proxy in between —
// must not be able to grow the engine's memory: the cap applies while reading,
// before the whole body is ever in memory.

/** Read a response body as UTF-8, or null once it exceeds `max` bytes. Throws
 *  what the body stream throws (a reset connection, an aborted deadline). */
export async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
