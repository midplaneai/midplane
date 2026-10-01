// Catalog snapshots leave the gateway with every literal in a view definition
// replaced by a placeholder of the same kind: names and types reach the
// cloud, values never do. The core decides nothing from a literal's value in
// a view (function classes go by name, casts by type, lineage by column), so
// the cloud's simulation of a redacted snapshot matches the gateway's own
// evaluation of the real one; the corpus tests prove it case by case.
//
// Audit records leave it the same way, with two differences: nothing
// evaluates a pushed statement and a person reads it, so a literal becomes a
// numbered parameter (`$1`), as pg_stat_statements prints statements; and
// an agent can write a value where a name goes (`WHERE email = "jane@…"`), so
// a name the database's catalog doesn't know becomes `_1`. Statement kinds
// the core doesn't evaluate keep strings in fields no walker vouches for
// (COPY's file, a role's password), so they go with no text at all.
//
// Kept, because they are not values: NULL and booleans, type modifiers
// (`varchar(10)`), an integer that is a whole ORDER BY, GROUP BY or DISTINCT
// ON item (a position the core resolves), and the keywords SQL syntax stores
// as strings: EXTRACT's field and NORMALIZE's form, when they are names
// Postgres knows.

import {
  AUDIT_KINDS_MAX,
  AUDIT_TEXT_MAX,
  type CatalogSnapshot,
  type Relation,
  type WithheldText,
} from "@midplane/protocol";
import type { A_Const, Node } from "@pgsql/types";
import { kindOf, stringsOf } from "./ast.ts";
import { relationKey } from "./catalog.ts";
import { parseAll, parseSelect, scanTokens } from "./parse.ts";
import { deparseFaithfully } from "./rewrite.ts";

/** What a string constant becomes. */
export const REDACTED_STRING = "?";
/** What a bit-string constant becomes: libpg_query's spelling of `B''`. */
const REDACTED_BITS = "b";
/** What a non-integer numeric constant becomes; it parses back as one. */
const REDACTED_FLOAT = "0.0";

class Unredactable extends Error {}

/** Schemas whose views the core reads without a definition. */
const SYSTEM = new Set(["pg_catalog", "information_schema"]);

const isNode = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** `A_Const` holding an integer: the one form the core reads as a position. */
function integerConst(node: unknown): A_Const | null {
  if (!isNode(node) || !isNode(node.A_Const)) return null;
  const c = node.A_Const as A_Const;
  return c.ival !== undefined ? c : null;
}

/**
 * The most a kept position may be. Postgres refuses a position past the
 * target list, so a bigger integer there is a value, not a position.
 */
const MAX_POSITION = 1000;

/** The integer constants a SELECT uses as positions of its output columns. */
function positions(select: Record<string, unknown>, into: Set<A_Const>): void {
  const add = (node: unknown) => {
    const c = integerConst(node);
    const n = c?.ival?.ival ?? 0;
    if (c && n >= 1 && n <= MAX_POSITION) into.add(c);
  };
  for (const s of (select.sortClause as unknown[] | undefined) ?? []) {
    if (isNode(s) && isNode(s.SortBy)) add(s.SortBy.node);
  }
  for (const d of (select.distinctClause as unknown[] | undefined) ?? []) {
    add(d);
  }
  const group = (items: unknown[] | undefined) => {
    for (const g of items ?? []) {
      if (isNode(g) && isNode(g.GroupingSet)) {
        group(g.GroupingSet.content as unknown[] | undefined);
      } else add(g);
    }
  };
  group(select.groupClause as unknown[] | undefined);
}

/** The units EXTRACT takes, with the abbreviations Postgres accepts. */
// biome-ignore format: grouped by unit for review
const EXTRACT_FIELDS: ReadonlySet<string> = new Set([
  "c", "cent", "centuries", "century",
  "d", "day", "days",
  "dec", "decade", "decades", "decs",
  "dow", "doy", "epoch",
  "h", "hour", "hours", "hr", "hrs",
  "isodow", "isoyear", "julian",
  "microsecond", "microseconds", "us", "usec", "usecond", "useconds", "usecs",
  "mil", "millennia", "millennium", "mils",
  "millisecond", "milliseconds", "ms", "msec", "msecond", "mseconds", "msecs",
  "m", "min", "mins", "minute", "minutes",
  "mon", "mons", "month", "months",
  "qtr", "quarter",
  "s", "sec", "second", "seconds", "secs",
  "timezone", "timezone_hour", "timezone_minute",
  "w", "week", "weeks",
  "y", "year", "years", "yr", "yrs",
]);

const NORMAL_FORMS: ReadonlySet<string> = new Set([
  "NFC",
  "NFD",
  "NFKC",
  "NFKD",
]);

/**
 * Keywords SQL syntax passes as string constants: EXTRACT's field and
 * NORMALIZE's form. Kept only when Postgres knows the name, so nothing else
 * can pass for one.
 */
function keywords(call: Record<string, unknown>, into: Set<A_Const>): void {
  if (call.funcformat !== "COERCE_SQL_SYNTAX") return;
  const name = stringsOf(call.funcname as Node[] | undefined)?.join(".");
  const args = (call.args as unknown[] | undefined) ?? [];
  const keep = (node: unknown, known: (s: string) => boolean) => {
    if (!isNode(node) || !isNode(node.A_Const)) return;
    const c = node.A_Const as A_Const;
    if (c.sval !== undefined && known(c.sval.sval ?? "")) into.add(c);
  };
  if (name === "pg_catalog.extract") {
    keep(args[0], (s) => EXTRACT_FIELDS.has(s.toLowerCase()));
  } else if (
    name === "pg_catalog.normalize" ||
    name === "pg_catalog.is_normalized"
  ) {
    keep(args[1], (s) => NORMAL_FORMS.has(s));
  }
}

/**
 * Where an agent-chosen name sits: plain string fields, and lists of String
 * nodes (nested `List`s too, as DROP's objects are), by node kind.
 */
const NAME_FIELDS: Readonly<
  Record<string, { strings?: readonly string[]; lists?: readonly string[] }>
> = {
  ColumnRef: { lists: ["fields"] },
  RangeVar: { strings: ["catalogname", "schemaname", "relname"] },
  Alias: { strings: ["aliasname"], lists: ["colnames"] },
  ResTarget: { strings: ["name"], lists: ["indirection"] },
  A_Indirection: { lists: ["indirection"] },
  CommonTableExpr: { strings: ["ctename"], lists: ["aliascolnames"] },
  ColumnDef: { strings: ["colname"] },
  IndexElem: { strings: ["name", "indexcolname"] },
  IndexStmt: { strings: ["idxname"] },
  Constraint: {
    strings: ["conname", "indexname"],
    lists: ["keys", "including", "fk_attrs", "pk_attrs"],
  },
  AlterTableCmd: { strings: ["name"] },
  RenameStmt: { strings: ["subname", "newname"] },
  AlterObjectSchemaStmt: { strings: ["newschema"] },
  DropStmt: { lists: ["objects"] },
  WindowDef: { strings: ["name", "refname"] },
  JoinExpr: { lists: ["usingClause"] },
  IntoClause: { lists: ["colNames"] },
  RowExpr: { lists: ["colnames"] },
};

/**
 * Fields that hold one of those nodes inline, without its kind as a
 * wrapper: `InsertStmt.relation` is a bare RangeVar, `RangeVar.alias` a bare
 * Alias.
 */
const INLINE_KINDS: Readonly<Record<string, string>> = {
  relation: "RangeVar",
  rel: "RangeVar",
  pktable: "RangeVar",
  alias: "Alias",
  join_using_alias: "Alias",
  intoClause: "IntoClause",
  into: "IntoClause",
  over: "WindowDef",
};

/**
 * Names SQL itself gives meaning, never the agent's text: ON CONFLICT's
 * `excluded` row and RETURNING's `old` and `new`.
 */
const SQL_NAMES: ReadonlySet<string> = new Set(["excluded", "old", "new"]);

interface RedactOptions {
  /**
   * What a literal becomes: a placeholder of its own kind, which keeps a
   * view's types for the simulator, or a numbered parameter, for a person.
   */
  literals: "typed" | "params";
  /**
   * Count parameter markers as values: they are the agent's when redacting,
   * and redaction's own when checking redacted text.
   */
  markersAreValues?: boolean;
  /**
   * Names to keep. Any other name in a name position becomes `_1`, `_2`…,
   * the same name the same placeholder. Absent: every name stays.
   */
  names?: ReadonlySet<string>;
}

/**
 * Replace every literal in a parsed tree, in place. Returns how many held
 * something other than their placeholder; with parameters, every literal
 * counts, since any that is left is a value.
 */
function redactTree(tree: Node, options: RedactOptions): number {
  const kept = new Set<A_Const>();
  const params: { ref: { number?: number }; location: number }[] = [];
  const renamed = new Map<string, string>();
  let changed = 0;

  /** Replace a typed literal; with parameters, the caller swaps the node. */
  const literal = (c: A_Const): boolean => {
    if (kept.has(c) || c.isnull || c.boolval !== undefined) return false;
    if (options.literals === "params") {
      if (
        c.sval === undefined &&
        c.bsval === undefined &&
        c.ival === undefined &&
        c.fval === undefined
      ) {
        throw new Unredactable("an unknown kind of constant");
      }
      changed++;
      return true;
    }
    if (c.sval !== undefined) {
      if (c.sval.sval !== REDACTED_STRING) changed++;
      c.sval = { sval: REDACTED_STRING };
    } else if (c.bsval !== undefined) {
      if (c.bsval.bsval !== REDACTED_BITS) changed++;
      c.bsval = { bsval: REDACTED_BITS };
    } else if (c.ival !== undefined) {
      if ((c.ival.ival ?? 0) !== 0) changed++;
      c.ival = {};
    } else if (c.fval !== undefined) {
      if (c.fval.fval !== REDACTED_FLOAT) changed++;
      c.fval = { fval: REDACTED_FLOAT };
    } else {
      // A constant of a kind this code doesn't know can't be vouched for.
      throw new Unredactable("an unknown kind of constant");
    }
    return false;
  };

  const rename = (name: string): string => {
    const names = options.names;
    if (!names || name === "" || names.has(name) || SQL_NAMES.has(name))
      return name;
    let out = renamed.get(name);
    if (out === undefined) {
      out = `_${renamed.size + 1}`;
      renamed.set(name, out);
    }
    return out;
  };

  const renameList = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!isNode(item)) continue;
      if (isNode(item.String)) {
        const s = item.String as { sval?: string };
        s.sval = rename(s.sval ?? "");
      } else if (isNode(item.List)) {
        renameList((item.List as { items?: unknown }).items);
      }
    }
  };

  const names = (kind: string, struct: Record<string, unknown>): void => {
    const fields = NAME_FIELDS[kind];
    if (!fields) return;
    for (const f of fields.strings ?? []) {
      const v = struct[f];
      if (typeof v === "string") struct[f] = rename(v);
    }
    for (const f of fields.lists ?? []) renameList(struct[f]);
  };

  const walk = (value: unknown, key: string | null): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v, null);
      return;
    }
    if (!isNode(value)) return;
    // Set operations hold their arms as bare SelectStmts.
    if (key === "SelectStmt" || key === "larg" || key === "rarg") {
      positions(value, kept);
    } else if (key === "FuncCall") keywords(value, kept);
    if (key && options.names) names(INLINE_KINDS[key] ?? key, value);
    for (const [k, v] of Object.entries(value)) {
      if (k === "typmods" && Array.isArray(v)) {
        // A type modifier is a number (`varchar(10)`) in any real type, but
        // the grammar takes any expression: keep only plain integers, small
        // ones, or an interval's fields, a bitmask printed as words
        // (`interval day to second`).
        const interval =
          stringsOf(value.names as Node[] | undefined)?.at(-1) === "interval";
        for (const m of v) {
          const c = integerConst(m);
          const n = c?.ival?.ival ?? 0;
          if (c && n >= 0 && (interval || n <= MAX_POSITION)) kept.add(c);
        }
        walk(v, k);
        continue;
      }
      if (
        k === "ParamRef" &&
        isNode(v) &&
        options.literals === "params" &&
        options.markersAreValues !== false
      ) {
        // A parameter marker the agent wrote is renumbered like a literal,
        // so its digits aren't the agent's.
        const ref = v as { number?: number; location?: number };
        params.push({ ref, location: ref.location ?? Number.MAX_SAFE_INTEGER });
        changed++;
        continue;
      }
      if (k === "A_Const" && isNode(v)) {
        if (literal(v as A_Const)) {
          // `value` is the one-key node wrapping the constant.
          const location = (v as A_Const).location;
          const ref: { number?: number; location?: number } = {};
          if (location !== undefined) ref.location = location;
          delete value.A_Const;
          value.ParamRef = ref;
          params.push({ ref, location: location ?? Number.MAX_SAFE_INTEGER });
        }
      } else if (k === "Float" || k === "BitString" || k === "Boolean") {
        // Values outside A_Const; SELECT grammar doesn't produce them.
        throw new Unredactable(`a bare ${k} value`);
      } else walk(v, k);
    }
  };

  walk(tree, null);
  // Numbered in the order the values were written, as Postgres numbers them.
  // A literal the tree holds twice (a multi-column SET's subquery sits under
  // each of its columns) is one value, so one number.
  let n = 0;
  let last: number | null = null;
  for (const p of params
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => a.location - b.location || a.i - b.i)) {
    if (p.location === Number.MAX_SAFE_INTEGER || p.location !== last) n++;
    last = p.location;
    p.ref.number = n;
  }
  return changed;
}

export type RedactedDefinition =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

/**
 * A view's defining SELECT with every literal replaced, checked by parsing
 * the result back. Requires `loadParser()`.
 */
export function redactDefinition(sql: string): RedactedDefinition {
  const select = parseSelect(sql);
  if (!select) return { ok: false, reason: "it is not a single SELECT" };
  const tree: Node = { SelectStmt: select };
  try {
    redactTree(tree, { literals: "typed" });
  } catch (err) {
    if (err instanceof Unredactable) return { ok: false, reason: err.message };
    throw err;
  }
  const out = deparseFaithfully(tree);
  if (out === null) {
    return { ok: false, reason: "it could not be printed back faithfully" };
  }
  return { ok: true, sql: out };
}

export interface WithheldDefinition {
  schema: string;
  name: string;
  /** Why it couldn't be redacted; for the gateway's log. */
  reason: string;
}

export interface RedactedCatalog {
  catalog: CatalogSnapshot;
  /** Views whose definition was left out because it couldn't be redacted. */
  withheld: WithheldDefinition[];
}

/**
 * The snapshot a gateway may send: every view definition redacted, or left
 * out when it can't be. The core denies a statement that reads a view
 * without a definition, so a withheld one fails closed in simulation.
 */
export function redactCatalog(catalog: CatalogSnapshot): RedactedCatalog {
  const withheld: WithheldDefinition[] = [];
  const relations = catalog.relations.map((r): Relation => {
    if (r.definition === undefined) return r;
    const out = redactDefinition(r.definition);
    if (out.ok) return { ...r, definition: out.sql };
    withheld.push({ schema: r.schema, name: r.name, reason: out.reason });
    const { definition: _, ...rest } = r;
    return rest;
  });
  return { catalog: { relations, routines: catalog.routines }, withheld };
}

/**
 * Relations whose definition still holds a literal, or doesn't parse as one
 * SELECT: what the cloud refuses to store. Requires `loadParser()`.
 */
export function unredactedDefinitions(catalog: CatalogSnapshot): string[] {
  const out: string[] = [];
  for (const r of catalog.relations) {
    if (r.definition === undefined) continue;
    const select = parseSelect(r.definition);
    let clean = false;
    if (select) {
      try {
        clean = redactTree({ SelectStmt: select }, { literals: "typed" }) === 0;
      } catch (err) {
        if (!(err instanceof Unredactable)) throw err;
      }
    }
    if (!clean) out.push(relationKey(r.schema, r.name));
  }
  return out;
}

/**
 * Views and materialized views outside the system schemas that have no
 * definition. A gateway always reads one, so these were withheld.
 */
export function withheldViews(catalog: CatalogSnapshot): string[] {
  return catalog.relations
    .filter(
      (r) =>
        (r.kind === "view" || r.kind === "materialized_view") &&
        r.definition === undefined &&
        !SYSTEM.has(r.schema),
    )
    .map((r) => relationKey(r.schema, r.name));
}

// ── statements, for the audit push ─────────────────────────────────────────

/** Statement kinds the core evaluates (or denies by rule): text may go up. */
const TEXT_KINDS: ReadonlySet<string> = new Set([
  "SelectStmt",
  "InsertStmt",
  "UpdateStmt",
  "DeleteStmt",
  "CreateStmt",
  "CreateTableAsStmt",
  "IndexStmt",
  "AlterTableStmt",
  "RenameStmt",
  "AlterObjectSchemaStmt",
  "DropStmt",
  "TruncateStmt",
]);

/**
 * Why a statement goes up with no text, as the record's `withheld` names it:
 *
 * - `parse`: it doesn't parse, or is over the core's size limit;
 * - `kind`: a statement kind the core doesn't evaluate;
 * - `check`: redaction couldn't vouch for it, or it didn't print back
 *   faithfully;
 * - `long`: too long to redact on the way out; the gateway's log keeps it.
 */
export type WithheldReason = WithheldText;

export type RedactedStatement = (
  | { ok: true; sql: string }
  | { ok: false; withheld: WithheldReason }
) & {
  /**
   * Each statement's kind, e.g. `InsertStmt` for `WITH … INSERT`, up to
   * the record's cap; none when it didn't parse.
   */
  kinds: string[];
};

/**
 * Statements longer than this (in UTF-16 units) go without text: redacting
 * one parses, walks and prints it twice over, which for 64 KiB held the
 * gateway's event loop for a third of a second, and what goes up is cut to
 * the record's statement cap anyway.
 */
export const MAX_REDACTED_INPUT = AUDIT_TEXT_MAX.statement;

/**
 * Names a statement may show as written: the catalog's schemas, relations
 * and columns. Anything else in a name position is the agent's own text.
 */
export function catalogNames(catalog: CatalogSnapshot): Set<string> {
  const out = new Set<string>();
  for (const r of catalog.relations) {
    out.add(r.schema);
    out.add(r.name);
    for (const c of r.columns) out.add(c.name);
  }
  return out;
}

/** Named tokens for operators the deparser prints: `::`, `<=`, `<>`… */
const SYMBOL_TOKENS: ReadonlySet<string> = new Set([
  "TYPECAST",
  "DOT_DOT",
  "COLON_EQUALS",
  "EQUALS_GREATER",
  "LESS_EQUALS",
  "GREATER_EQUALS",
  "NOT_EQUALS",
  "Op",
]);

/**
 * Operator text, as the scanner gives the operators it has no name for
 * (`||`, `->>`, `@>`), and the punctuation around them. A bit or hex string
 * comes back unnamed too (`X'6a61'`), with a quote in it.
 */
const OPERATOR_TEXT = /^[-+*/<>=~!@#%^&|`?.:[\]]+$/;

/** Quoted names Postgres itself defines: collations, not values. */
const QUOTED_BUILTINS: ReadonlySet<string> = new Set([
  "C",
  "POSIX",
  "default",
  "ucs_basic",
  "unicode",
  "pg_c_utf8",
  "pg_unicode_fast",
]);

/**
 * Whether a name is a Postgres keyword, which the deparser quotes where it
 * is used as a name (`"left"(name, 2)`): code, not a value.
 */
function isKeyword(name: string): boolean {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) return false;
  const tokens = scanTokens(name);
  return tokens?.length === 1 && tokens[0]?.keyword === true;
}

/**
 * The allowlist every redacted statement must pass, read token by token.
 * A token passes only as a keyword; a name, unquoted, or quoted when it is
 * in `names`, a collation Postgres defines or a keyword; a parameter
 * marker, numbered no higher than there are markers; an integer up to 1000
 * (positions and type modifiers are small); or punctuation and operators.
 * Anything else fails: strings of every spelling, bit and hex strings,
 * floats, comments, `U&` escapes. A quoted identifier is where a value
 * written as a name would be (`"jane@example.com"`), whatever position the
 * walker missed; without `names`, only collations and keywords pass quoted.
 * Null when the text fails, else whether it holds an integer.
 */
function clean(
  sql: string,
  names?: ReadonlySet<string>,
): { integers: boolean } | null {
  const tokens = scanTokens(sql);
  if (!tokens) return null;
  let markers = 0;
  let highest = 0;
  let integers = false;
  for (const t of tokens) {
    if (t.tokenName === "ICONST") {
      if (!/^\d{1,4}$/.test(t.text) || Number(t.text) > MAX_POSITION)
        return null;
      integers = true;
    } else if (t.tokenName === "PARAM") {
      markers++;
      const n = /^\$(\d{1,9})$/.exec(t.text)?.[1];
      if (n === undefined) return null;
      highest = Math.max(highest, Number(n));
    } else if (t.tokenName === "IDENT") {
      if (!t.text.startsWith('"')) continue;
      const name = t.text.slice(1, -1).replaceAll('""', '"');
      if (
        !t.text.endsWith('"') ||
        !(names?.has(name) || QUOTED_BUILTINS.has(name) || isKeyword(name))
      )
        return null;
    } else if (t.keyword) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t.text)) return null;
    } else if (
      /^ASCII_\d+$/.test(t.tokenName) ||
      t.tokenName === "UNKNOWN" ||
      SYMBOL_TOKENS.has(t.tokenName)
    ) {
      if (!/^[(),;]$/.test(t.text) && !OPERATOR_TEXT.test(t.text)) return null;
    } else {
      return null;
    }
  }
  return highest <= markers ? { integers } : null;
}

/**
 * A statement as the cloud may see it by default: every literal a numbered
 * parameter, comments gone, and, given the catalog's names, every other
 * name a placeholder. The result must parse back to the same trees and pass
 * the token allowlist; a statement that can't be vouched for has no text,
 * never the original. Stacked statements are redacted one by one. Total:
 * any failure is a withheld statement. Requires `loadParser()`.
 */
export function redactStatement(
  sql: string,
  names?: ReadonlySet<string>,
): RedactedStatement {
  if (sql.length > MAX_REDACTED_INPUT) {
    return { ok: false, withheld: "long", kinds: [] };
  }
  let kinds: string[] = [];
  try {
    const stmts = parseAll(sql);
    if (!stmts) return { ok: false, withheld: "parse", kinds: [] };
    kinds = stmts.map((s) => kindOf(s) ?? "unknown").slice(0, AUDIT_KINDS_MAX);
    if (stmts.some((s) => !TEXT_KINDS.has(kindOf(s) ?? ""))) {
      return { ok: false, withheld: "kind", kinds };
    }
    // One tree, so numbering and placeholders run across every statement.
    const tree = { stmts } as unknown as Node;
    redactTree(tree, { literals: "params", ...(names ? { names } : {}) });
    const out: string[] = [];
    for (const stmt of stmts) {
      const text = deparseFaithfully(stmt);
      if (text === null) return { ok: false, withheld: "check", kinds };
      out.push(text);
    }
    const text = out.join(";\n");
    if (!clean(text, names)) return { ok: false, withheld: "check", kinds };
    return { ok: true, sql: text, kinds };
  } catch {
    // An unknown node, a deparser that gives up, a statement nested too
    // deep for the stack: whatever it is, the statement goes without text.
    return { ok: false, withheld: "check", kinds };
  }
}

/**
 * Whether a redacted statement's text could still carry a value: what the
 * cloud refuses to store. The same token allowlist the gateway applies, so
 * it holds for text cut to fit too and costs a scan; text holding an
 * integer is also parsed, to tell a position from a value. `names` are the
 * catalog's, when the cloud has one. Requires `loadParser()`.
 */
export function unredactedStatement(
  sql: string,
  names?: ReadonlySet<string>,
): boolean {
  const scanned = clean(sql, names);
  if (!scanned) return true;
  if (!scanned.integers) return false;
  // The scan can't tell an ORDER BY position from `WHERE age = 42`, so
  // text with an integer is read as a tree, where only positions and type
  // modifiers may hold one. Text cut to fit doesn't parse: with an integer
  // in it, it loses its text rather than risk a value.
  const stmts = parseAll(sql);
  if (!stmts) return true;
  try {
    return (
      redactTree({ stmts } as unknown as Node, {
        literals: "params",
        markersAreValues: false,
      }) > 0
    );
  } catch {
    return true;
  }
}
