// Coarse statement-kind classification for audit-list legibility. Derived
// at render time from the SQL text the OSS engine recorded on the ATTEMPTED
// row — NOT a stored column, so it needs no migration and costs nothing on
// the read path. The point is scannability: a reviewer should be able to
// see "this agent ran four reads and one blocked write" without parsing SQL.
//
// Deliberately coarse. The OSS engine's AST parser owns the authoritative
// per-statement type (surfaced on the DECIDED payload + the detail page);
// this is only the at-a-glance bucket the list table renders.

export type SqlKind = "read" | "write" | "ddl" | "other";

// Only the three meaningful buckets get a label; `other`/unknown render
// nothing so the column isn't peppered with "OTHER" noise.
export const SQL_KIND_LABELS: Record<Exclude<SqlKind, "other">, string> = {
  read: "READ",
  write: "WRITE",
  ddl: "DDL",
};

// Leading keyword → bucket. Read covers row-returning + introspection;
// write covers row-mutating DML; DDL covers schema + privilege +
// maintenance statements (the highest-impact class for an audit reviewer).
const READ = new Set(["select", "show", "explain", "with", "table", "values"]);
const WRITE = new Set(["insert", "update", "delete", "merge", "upsert"]);
const DDL = new Set([
  "create",
  "alter",
  "drop",
  "truncate",
  "rename",
  "comment",
  "grant",
  "revoke",
  "vacuum",
  "analyze",
  "reindex",
  "cluster",
]);

export function classifySql(sql: string | null | undefined): SqlKind | null {
  if (!sql) return null;
  const head = firstKeyword(sql);
  if (!head) return null;
  if (WRITE.has(head)) return "write";
  if (DDL.has(head)) return "ddl";
  if (READ.has(head)) {
    // A `WITH …` CTE prelude can wrap a data-modifying statement
    // (`WITH x AS (...) DELETE …`). Resolve to the inner verb so a
    // writing CTE doesn't masquerade as a read.
    if (head === "with" && /\b(insert|update|delete|merge)\b/i.test(sql)) {
      return "write";
    }
    return "read";
  }
  return "other";
}

// First significant keyword, after stripping leading line/block comments
// (the OSS may prepend a `/* midplane:intent="…" */` hint) and opening
// parens (`(SELECT …) UNION …`).
function firstKeyword(sql: string): string | null {
  let s = sql.trim();
  for (let guard = 0; guard < 20; guard++) {
    if (s.startsWith("--")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1).trimStart();
      continue;
    }
    if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2).trimStart();
      continue;
    }
    if (s.startsWith("(")) {
      s = s.slice(1).trimStart();
      continue;
    }
    break;
  }
  const m = /^([a-z]+)/i.exec(s);
  return m ? m[1]!.toLowerCase() : null;
}
