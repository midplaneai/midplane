// Catalog resolver — turns the OIDs in a result's RowDescription into the
// RelInfo the masker needs (schema, relname, relkind, partition parent, column
// names). Resolved from pg_class / pg_namespace / pg_attribute / pg_inherits.
//
// No hard pg dependency: takes a generic `queryFn` so the engine package stays
// driver-agnostic (mirrors how Executor is DI'd). Production wires it to the
// connection's pool; tests wire it to a client. Caller caches the result per
// connection and refreshes on a masker "could not resolve" reject (fail-closed
// + refresh on miss — decision A4).

import type { Catalog, RelInfo } from "./mask-result-set.ts";

export type CatalogQueryFn = (
  sql: string,
  params: unknown[],
) => Promise<Record<string, unknown>[]>;

/** What the engine calls to turn result OIDs into a Catalog. Injected like the
 *  Executor so the engine package stays driver-agnostic. */
export interface CatalogResolver {
  /** Resolve a Catalog covering these OIDs (and their partition parents). */
  resolve(oids: number[]): Promise<Catalog>;
  /** Drop any cache so the next resolve() re-reads the catalog. Called by the
   *  engine after a retryable (cache-stale) masker reject. */
  invalidate(): void;
}

/**
 * Caching resolver: keeps a per-connection OID->RelInfo cache, fetches only the
 * OIDs it doesn't yet know, and serves subsequent queries from memory. OIDs are
 * stable per database except across DROP+recreate, so a miss-driven invalidate
 * (not polling) is sufficient. Fail-closed is the masker's job — this layer
 * just resolves what it can.
 */
export class CachingCatalogResolver implements CatalogResolver {
  private cache: Catalog = new Map();

  constructor(private readonly queryFn: CatalogQueryFn) {}

  async resolve(oids: number[]): Promise<Catalog> {
    const missing = oids.filter((o) => o > 0 && !this.cache.has(o));
    if (missing.length > 0) {
      const fresh = await buildCatalog(this.queryFn, missing);
      for (const [oid, info] of fresh) this.cache.set(oid, info);
    }
    return this.cache;
  }

  invalidate(): void {
    this.cache = new Map();
  }
}

/**
 * Build a Catalog covering the given source OIDs and their partition/inheritance
 * parents (so a directly-queried child resolves up to the parent's declared mask).
 */
export async function buildCatalog(
  queryFn: CatalogQueryFn,
  oids: Iterable<number>,
): Promise<Catalog> {
  const want = new Set<number>();
  for (const o of oids) if (o && o > 0) want.add(o);
  if (want.size === 0) return new Map();

  // pg_inherits is small; fetch all edges and walk to the top ancestor in JS
  // (cycle-guarded). Covers both declarative partitions and table inheritance.
  const inhRows = await queryFn(
    "SELECT inhrelid::int8 AS child, inhparent::int8 AS parent FROM pg_inherits",
    [],
  );
  const parentOf = new Map<number, number>();
  for (const r of inhRows) parentOf.set(Number(r.child), Number(r.parent));
  const topAncestor = (oid: number): number => {
    let cur = oid;
    const seen = new Set<number>([cur]);
    while (parentOf.has(cur)) {
      const p = parentOf.get(cur)!;
      if (seen.has(p)) break; // defensive: cycle
      seen.add(p);
      cur = p;
    }
    return cur;
  };

  // The set we must describe = requested oids ∪ their top parents.
  const all = new Set<number>();
  for (const o of want) {
    all.add(o);
    all.add(topAncestor(o));
  }
  const allArr = [...all];

  const relRows = await queryFn(
    `SELECT c.oid::int8 AS oid, c.relname, c.relkind, n.nspname AS schema
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = ANY($1::oid[])`,
    [allArr],
  );
  // Join pg_type so each column carries its typcategory (e.g. 'S' string,
  // 'D' date/time, 'N' numeric) — the masker keys the parametric transforms'
  // input-type domains on it (atttypid → typcategory). Category letters cover
  // extension/domain types (citext, custom domains) without a per-OID allowlist.
  const attRows = await queryFn(
    `SELECT a.attrelid::int8 AS oid, a.attnum::int4 AS attnum, a.attname,
            t.typcategory
       FROM pg_attribute a
       JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attrelid = ANY($1::oid[]) AND a.attnum > 0 AND NOT a.attisdropped`,
    [allArr],
  );

  const colsByOid = new Map<number, Map<number, string>>();
  const typesByOid = new Map<number, Map<number, string>>();
  for (const r of attRows) {
    const oid = Number(r.oid);
    const attnum = Number(r.attnum);
    let m = colsByOid.get(oid);
    if (!m) colsByOid.set(oid, (m = new Map()));
    m.set(attnum, String(r.attname));
    if (r.typcategory != null) {
      let tm = typesByOid.get(oid);
      if (!tm) typesByOid.set(oid, (tm = new Map()));
      tm.set(attnum, String(r.typcategory));
    }
  }

  const catalog: Catalog = new Map();
  for (const r of relRows) {
    const oid = Number(r.oid);
    const info: RelInfo = {
      schema: String(r.schema),
      relname: String(r.relname),
      relkind: String(r.relkind),
      topParentOid: topAncestor(oid),
      columns: colsByOid.get(oid) ?? new Map(),
      columnTypes: typesByOid.get(oid) ?? new Map(),
    };
    catalog.set(oid, info);
  }
  return catalog;
}
