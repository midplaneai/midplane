// Client-side policy evaluator for the landing-page demo. Mirrors the
// OSS engine's table_access decision surface for the four DML verbs +
// DDL refusal — enough to make the demo feel honest without vendoring
// the engine's Rust SQL parser. Real production traffic still flows
// through the engine; this is a teaching tool.

import type { TableAccessPolicy } from "@midplane-cloud/db/policy";

import { FIXTURE_TABLES, type FixtureRow } from "./fixtures";

export type Operation = "read" | "write" | "ddl" | "unknown";

export interface Decision {
  decision: "allow" | "deny";
  reason: string;
  // The policy path that produced the reason — `default` or
  // `tables.<name>`. Lets the audit log render the same shorthand the
  // YAML config uses.
  policyPath: string;
  table: string | null;
  op: Operation;
  rows?: FixtureRow[];
  rowsAffected?: number;
  // Pretty SQL echoed back so the chat transcript matches what the
  // engine would have logged after normalization.
  normalizedSql: string;
}

// Strip trailing semicolon + collapse whitespace. The engine sees the
// statement post-tokenization; this is the cheapest faithful echo.
function normalize(sql: string): string {
  return sql.trim().replace(/;\s*$/, "").replace(/\s+/g, " ");
}

// Cheap multi-line formatter — newline before each major clause. Not a
// real SQL parser; handles SELECT/INSERT/UPDATE/DELETE with the
// clauses the demo cares about. Nested subqueries / CTEs fall back to
// "fine, not gorgeous." Used only for display; the evaluator works
// off `normalizedSql`.
const CLAUSE_KEYWORDS = [
  "FROM",
  "WHERE",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "RETURNING",
  "VALUES",
  "SET",
];
export function prettyPrintSql(sql: string): string {
  let out = sql.trim().replace(/;\s*$/, "");
  for (const kw of CLAUSE_KEYWORDS) {
    out = out.replace(new RegExp(`\\s+(${kw})\\b`, "gi"), "\n$1");
  }
  return out;
}

const DDL_VERBS = /^\s*(drop|truncate|alter|create|grant|revoke)\b/i;
const SELECT_RE = /^\s*select\b[\s\S]*?\bfrom\s+([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?)/i;
const INSERT_RE = /^\s*insert\s+into\s+([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?)/i;
const UPDATE_RE = /^\s*update\s+([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?)/i;
const DELETE_RE = /^\s*delete\s+from\s+([a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?)/i;

function levelFor(policy: TableAccessPolicy, table: string) {
  const lower = table.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(policy.tables, lower)) {
    return { level: policy.tables[lower], path: `tables.${lower}`, declared: true };
  }
  // The OSS engine has an explicit `default:` field; the demo UI
  // hides it and pins it to deny. Surface the deny as "not in
  // allowlist" so the visitor's mental model matches the editor on
  // their right rather than the YAML they haven't seen.
  return { level: policy.default, path: "default", declared: false };
}

export function evaluate(rawSql: string, policy: TableAccessPolicy): Decision {
  const normalizedSql = normalize(rawSql);

  if (DDL_VERBS.test(normalizedSql)) {
    return {
      decision: "deny",
      reason: "DDL is denied by the engine (statements: drop, truncate, alter, create, grant, revoke)",
      policyPath: "engine.ddl_refused",
      table: null,
      op: "ddl",
      normalizedSql,
    };
  }

  const select = normalizedSql.match(SELECT_RE);
  if (select && select[1]) {
    const table = select[1];
    const { level, path, declared } = levelFor(policy, table);
    if (level === "read" || level === "read_write") {
      const rows = FIXTURE_TABLES[table.toLowerCase()] ?? [];
      return {
        decision: "allow",
        reason: `${path} = ${level}`,
        policyPath: path,
        table,
        op: "read",
        rows: applyLimit(rows, normalizedSql),
        normalizedSql,
      };
    }
    return {
      decision: "deny",
      reason: declared
        ? `${path} = ${level} — read not permitted`
        : `${table} is not in the allowlist`,
      policyPath: path,
      table,
      op: "read",
      normalizedSql,
    };
  }

  const writeMatch =
    normalizedSql.match(INSERT_RE) ??
    normalizedSql.match(UPDATE_RE) ??
    normalizedSql.match(DELETE_RE);
  if (writeMatch && writeMatch[1]) {
    const table = writeMatch[1];
    const { level, path, declared } = levelFor(policy, table);
    if (level === "read_write") {
      const fixture = FIXTURE_TABLES[table.toLowerCase()] ?? [];
      // INSERT always reports 1 row; UPDATE/DELETE without WHERE
      // affects the whole fixture, with WHERE we estimate 1 to mirror
      // the typical "by id" pattern in the demo examples.
      const isInsert = /^\s*insert/i.test(normalizedSql);
      const hasWhere = /\bwhere\b/i.test(normalizedSql);
      const rowsAffected = isInsert ? 1 : hasWhere ? 1 : fixture.length;
      return {
        decision: "allow",
        reason: `${path} = read_write`,
        policyPath: path,
        table,
        op: "write",
        rowsAffected,
        normalizedSql,
      };
    }
    return {
      decision: "deny",
      reason: declared
        ? `${path} = ${level} — write not permitted`
        : `${table} is not in the allowlist`,
      policyPath: path,
      table,
      op: "write",
      normalizedSql,
    };
  }

  return {
    decision: "deny",
    reason: "could not parse statement (demo evaluator supports SELECT / INSERT / UPDATE / DELETE / DDL)",
    policyPath: "engine.parse_failed",
    table: null,
    op: "unknown",
    normalizedSql,
  };
}

function applyLimit(rows: FixtureRow[], sql: string): FixtureRow[] {
  const m = sql.match(/\blimit\s+(\d+)/i);
  if (!m || !m[1]) return rows;
  const n = Math.max(0, Number.parseInt(m[1], 10));
  return rows.slice(0, n);
}
