// Lookup over a catalog snapshot, resolving names the way the gateway's
// session does: unqualified relations search `pg_catalog`, then `public`.

import type { CatalogSnapshot, Relation } from "@midplane/protocol";

/**
 * The search path the gateway pins for every statement. `pg_catalog` comes
 * first so a user-defined relation or function can't shadow a builtin.
 */
export const SEARCH_PATH = ["pg_catalog", "public"] as const;

/** Where unqualified tables are created. */
export const CREATION_SCHEMA = "public";

export function relationKey(schema: string, name: string): string {
  return `${schema}.${name}`;
}

export class CatalogIndex {
  private readonly relations = new Map<string, Relation>();
  private readonly routineNames = new Map<string, Set<string>>();
  private readonly children = new Map<string, Relation[]>();

  constructor(snapshot: CatalogSnapshot) {
    for (const r of snapshot.relations) {
      this.relations.set(relationKey(r.schema, r.name), r);
      if (r.parent) {
        const key = relationKey(r.parent.schema, r.parent.name);
        this.children.set(key, [...(this.children.get(key) ?? []), r]);
      }
    }
    for (const r of snapshot.routines) {
      const names = this.routineNames.get(r.schema) ?? new Set<string>();
      names.add(r.name);
      this.routineNames.set(r.schema, names);
    }
  }

  /** Partitions and inheritance children of a relation. */
  childrenOf(schema: string, name: string): Relation[] {
    return this.children.get(relationKey(schema, name)) ?? [];
  }

  get(schema: string, name: string): Relation | undefined {
    return this.relations.get(relationKey(schema, name));
  }

  /** Resolve a relation as written; unqualified names use SEARCH_PATH. */
  resolve(schema: string | null, name: string): Relation | undefined {
    if (schema !== null) return this.get(schema, name);
    for (const s of SEARCH_PATH) {
      const r = this.get(s, name);
      if (r) return r;
    }
    return undefined;
  }

  /**
   * True when a function, operator or type named `name` is defined in a searched
   * schema other than `pg_catalog`. Postgres picks an overload by argument
   * types before search order, so such a definition can win over a builtin.
   */
  shadowsBuiltin(name: string): boolean {
    for (const s of SEARCH_PATH) {
      if (s !== "pg_catalog" && this.routineNames.get(s)?.has(name))
        return true;
    }
    return false;
  }
}
