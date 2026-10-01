// Small readers over the libpg_query AST. Every node is a one-key object
// (`{ SelectStmt: {...} }`); fields inside a node are plain objects.

import type { Node } from "@pgsql/types";

/** The node's kind, e.g. `SelectStmt`; null for anything not a node. */
export function kindOf(node: unknown): string | null {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  const keys = Object.keys(node);
  return keys.length === 1 ? (keys[0] ?? null) : null;
}

/** The value of a `{ String: { sval } }` node. */
export function stringOf(node: Node | undefined): string | null {
  if (node && "String" in node) return node.String.sval ?? "";
  return null;
}

/** Every `String` value of a name list, or null if any element isn't one. */
export function stringsOf(nodes: Node[] | undefined): string[] | null {
  const out: string[] = [];
  for (const n of nodes ?? []) {
    const s = stringOf(n);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

/** A qualified name as written: the last part, and the schema before it. */
export interface QualName {
  schema: string | null;
  name: string;
}

export function qualNameOf(nodes: Node[] | undefined): QualName | null {
  const parts = stringsOf(nodes);
  if (!parts || parts.length === 0) return null;
  const name = parts[parts.length - 1] ?? "";
  const schema = parts.length >= 2 ? (parts[parts.length - 2] ?? null) : null;
  return { schema, name };
}

/** A deep copy, for building new trees out of parts of the parsed one. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
