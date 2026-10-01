// The decide stage: every rule that turns a resolved statement into allow,
// hold or deny. Table access runs earlier, as each relation binds; the rest
// runs here in a fixed order, and the first denial wins.

import {
  type AccessLevel,
  type ClassAction,
  type DatabasePolicy,
  databaseScope,
  type HoldCause,
} from "@midplane/protocol";
import type { CatalogIndex } from "./catalog.ts";
import { relationKey } from "./catalog.ts";
import { Deny } from "./deny.ts";
import {
  dangerousCapability,
  MASK_SAFE_FUNCTIONS,
  MASK_SAFE_OPERATORS,
} from "./functions.ts";
import type { BaseColumn, Resolver } from "./resolve.ts";
import { masksFor, ruleFor } from "./rewrite.ts";
import type { Classification, StatementAnalysis } from "./statement.ts";
import type { EvaluateInput, TaintSource } from "./types.ts";

// ── scope ───────────────────────────────────────────────────────────────────

export function checkScope(input: EvaluateInput, writes: boolean): void {
  const scopes = new Set(input.caller.scopes);
  const canWrite = scopes.has(databaseScope(input.databaseId, "write"));
  const canRead =
    canWrite || scopes.has(databaseScope(input.databaseId, "read"));
  if (writes ? canWrite : canRead) return;
  throw new Deny(
    "scope",
    writes
      ? "Midplane denied this write because this agent's access to the database is read-only. Writes need the database's write scope, granted at consent or in the token."
      : "Midplane denied this query because this agent has no access to this database. Access is granted at consent or in the token.",
  );
}

// ── table access ────────────────────────────────────────────────────────────

export function accessLevel(
  policy: DatabasePolicy,
  schema: string,
  name: string,
  parent?: { schema: string; name: string },
): AccessLevel {
  // information_schema describes the catalog, never row data; agents need it
  // to find their way. pg_catalog gets no such pass: it exposes settings,
  // function bodies and statistics.
  if (schema === "information_schema") return "read";
  const tables = policy.table_access.tables;
  // A partition without its own entry takes its parent's: its rows are the
  // parent's rows, so denying the parent must deny reading them directly.
  return (
    tables[relationKey(schema, name)] ??
    (parent ? tables[relationKey(parent.schema, parent.name)] : undefined) ??
    policy.table_access.default
  );
}

function permits(level: AccessLevel): string {
  switch (level) {
    case "deny":
      return "which permits neither reads nor writes";
    case "read":
      return "which permits reads only";
    case "read_write":
      return "which permits reads and writes";
  }
}

/** Table access for one relation reference; throws on a denial. */
export function checkAccess(
  policy: DatabasePolicy,
  schema: string,
  name: string,
  position: "read" | "write",
  parent?: { schema: string; name: string },
): void {
  const level = accessLevel(policy, schema, name, parent);
  const table = relationKey(schema, name);
  if (position === "write" && level !== "read_write") {
    throw new Deny(
      "table_access",
      `Midplane denied this query because writes to table \`${table}\` are not allowed by the table-access policy (\`${table}\` resolves to \`${level}\`, ${permits(level)}). Another write to \`${table}\` will be denied the same way.`,
    );
  }
  if (position === "read" && level === "deny") {
    throw new Deny(
      "table_access",
      `Midplane denied this query because reads from table \`${table}\` are not allowed by the table-access policy (\`${table}\` resolves to \`deny\`, ${permits(level)}). Another read of \`${table}\` will be denied the same way.`,
    );
  }
}

// ── the rest ────────────────────────────────────────────────────────────────

export type Decision =
  | { action: "allow"; dependsOnTaint: boolean }
  | { action: "hold"; cause: HoldCause; dependsOnTaint: boolean };

function hasLabels(policy: DatabasePolicy, key: string): boolean {
  return (
    policy.labels.secret_tables.includes(key) ||
    (policy.labels.untrusted_columns[key]?.length ?? 0) > 0
  );
}

/**
 * The first relation the statement touches that is labeled, itself, through
 * its parent or through one of its partitions, or null. Writes count: a
 * write's WHERE and RETURNING read the table it changes.
 */
function labeledTouched(
  catalog: CatalogIndex,
  resolver: Resolver,
  labeled: (key: string) => boolean,
): string | null {
  const touched = [
    ...resolver.uses.map((u) => u.relation),
    ...resolver.viewUses.map((u) => u.relation),
  ];
  for (const r of touched) {
    const key = relationKey(r.schema, r.name);
    const parentKey = r.parent
      ? relationKey(r.parent.schema, r.parent.name)
      : null;
    const childKeys = catalog
      .childrenOf(r.schema, r.name)
      .map((c) => relationKey(c.schema, c.name));
    if (
      labeled(key) ||
      (parentKey !== null && labeled(parentKey)) ||
      childKeys.some(labeled)
    ) {
      return key;
    }
  }
  return null;
}

function secretTouched(
  policy: DatabasePolicy,
  catalog: CatalogIndex,
  resolver: Resolver,
): string | null {
  const secret = new Set(policy.labels.secret_tables);
  if (secret.size === 0) return null;
  return labeledTouched(catalog, resolver, (k) => secret.has(k));
}

/**
 * Whether the statement touches a table with columns labeled untrusted.
 * Postgres can quote a value it read in an error, whatever the statement
 * returns.
 */
export function untrustedTouched(
  policy: DatabasePolicy,
  catalog: CatalogIndex,
  resolver: Resolver,
): boolean {
  const untrusted = policy.labels.untrusted_columns;
  return (
    labeledTouched(
      catalog,
      resolver,
      (k) => (untrusted[k]?.length ?? 0) > 0,
    ) !== null
  );
}

export function decide(
  input: EvaluateInput,
  catalog: CatalogIndex,
  classification: Classification,
  analysis: StatementAnalysis,
  resolver: Resolver,
): Decision {
  const { policy } = input;

  // Writes name their rows.
  if (analysis.where && !analysis.where.present) {
    throw new Deny(
      "where_required",
      `Midplane denied this query because this ${analysis.where.operation} on \`${analysis.where.table}\` has no WHERE clause, which would change every row in the table. Add a WHERE clause that scopes the rows you intend to change.`,
    );
  }

  // Functions that reach data outside their arguments.
  // Calls inside a view's definition run too, so they count.
  for (const fn of [...resolver.functions, ...resolver.viewFunctions]) {
    const capability = dangerousCapability(fn.name);
    if (capability) {
      throw new Deny(
        "dangerous_function",
        `Midplane denied this query because it calls \`${fn.name}\`, which ${capability}. Midplane blocks this regardless of table-access policy. Query the tables you need directly instead, naming them in the statement.`,
      );
    }
  }

  // Renaming or moving a protected table would detach its masks and labels,
  // which are keyed by name.
  for (const r of analysis.renamed) {
    const key = relationKey(r.schema, r.name);
    if (masksFor(policy, r) || hasLabels(policy, key)) {
      throw new Deny(
        "mask",
        `Midplane denied this query because \`${key}\` has masks or labels, which are keyed by name, so it can't be renamed or moved.`,
      );
    }
  }

  if (Object.keys(policy.masks).length > 0) {
    maskGate(policy, catalog, resolver, classification);
  }

  // Containment: a tainted grant may not touch secret tables.
  const secret = secretTouched(policy, catalog, resolver);
  if (input.tainted && secret !== null) {
    throw new Deny(
      "containment",
      `Midplane denied this query because it touches \`${secret}\`, which is labeled secret, and this agent has read untrusted content since it was authorized. Secret tables stay closed to it until a person clears the taint or the grant ends.`,
    );
  }

  const write = classification.write;
  if (!write) return { action: "allow", dependsOnTaint: secret !== null };
  const action: ClassAction = policy.writes[write.class];
  if (action === "deny") {
    const what =
      write.class === "row_changes" ? "row changes" : "schema changes";
    throw new Deny(
      "write_class",
      `Midplane denied this query because ${write.operation} is one of the ${what}, which this database refuses. Reads are unaffected.`,
    );
  }
  // A held class holds whatever the taint: only a secret table makes it matter.
  if (action === "hold")
    return { action: "hold", cause: "class", dependsOnTaint: secret !== null };
  // While tainted, every write waits for a person.
  if (input.tainted)
    return { action: "hold", cause: "taint", dependsOnTaint: true };
  return { action: "allow", dependsOnTaint: true };
}

/**
 * With masks on the database, every function and operator must be a vetted
 * builtin: anything else (a user-defined function, dynamic SQL) could read a
 * masked table without passing through the rewrite.
 */
// Catalog views that publish sampled column values, settings or other
// sessions' statement text: each would show masked data unmasked.
const VALUE_EXPOSING = new Set([
  "pg_stats",
  "pg_stats_ext",
  "pg_stats_ext_exprs",
  "pg_statistic",
  "pg_statistic_ext",
  "pg_statistic_ext_data",
  "pg_settings",
  "pg_stat_activity",
  "pg_stat_statements",
]);

function maskGate(
  policy: DatabasePolicy,
  catalog: CatalogIndex,
  resolver: Resolver,
  classification: Classification,
): void {
  const deny = (reason: string) =>
    new Deny(
      "mask",
      `Midplane denied this query because ${reason}. This database has masked columns, so only vetted built-in functions and operators may run.`,
    );
  for (const fn of [...resolver.functions, ...resolver.viewFunctions]) {
    const name = fn.name.toLowerCase();
    if (fn.schema !== null && fn.schema !== "pg_catalog") {
      throw deny(
        `it calls the schema-qualified function \`${fn.schema}.${fn.name}\``,
      );
    }
    if (!MASK_SAFE_FUNCTIONS.has(name)) {
      throw deny(`it calls \`${fn.name}\`, which is not on the mask-safe list`);
    }
    if (catalog.shadowsBuiltin(name)) {
      throw deny(
        `\`${fn.name}\` is also defined outside pg_catalog, so the call can't be proven to reach the builtin`,
      );
    }
  }
  for (const op of resolver.operators) {
    if (op.schema !== null && op.schema !== "pg_catalog") {
      throw deny(
        `it uses the schema-qualified operator \`${op.schema}.${op.name}\``,
      );
    }
    if (!MASK_SAFE_OPERATORS.has(op.name)) {
      throw deny(
        `it uses the operator \`${op.name}\`, which is not on the mask-safe list`,
      );
    }
    if (catalog.shadowsBuiltin(op.name)) {
      throw deny(
        `the operator \`${op.name}\` is also defined outside pg_catalog`,
      );
    }
  }
  // A cast to a type defined outside pg_catalog can run its input function or
  // a domain's CHECK: user code, like a user function.
  for (const t of resolver.types) {
    if (t.schema !== null && t.schema !== "pg_catalog") {
      throw deny(
        `it casts to the type \`${t.schema}.${t.name}\`, defined outside pg_catalog`,
      );
    }
    if (t.schema === null && catalog.shadowsBuiltin(t.name)) {
      throw deny(
        `it casts to \`${t.name}\`, a type defined outside pg_catalog`,
      );
    }
  }
  const touched = [
    ...resolver.uses.map((x) => x.relation),
    ...resolver.viewUses.map((x) => x.relation),
  ];
  for (const r of touched) {
    if (VALUE_EXPOSING.has(r.name)) {
      throw deny(
        `it reads \`${r.schema}.${r.name}\`, which shows column values or statement text unmasked`,
      );
    }
  }
  // Reading a parent returns its partitions' rows under the parent's masks,
  // so a partition with masks of its own can't be read that way.
  for (const u of resolver.uses) {
    if (u.position !== "read" || u.rv.inh !== true) continue;
    const child = catalog
      .childrenOf(u.relation.schema, u.relation.name)
      .find((c) => policy.masks[relationKey(c.schema, c.name)]);
    if (child) {
      throw deny(
        `partition \`${child.schema}.${child.name}\` has masks of its own, so its rows can't be read through \`${u.key}\`; declare the masks on \`${u.key}\``,
      );
    }
  }
  // A schema change can evaluate raw values of the table it changes: a USING
  // expression, a CHECK constraint, a partial index predicate.
  if (
    classification.kind === "AlterTableStmt" ||
    classification.kind === "IndexStmt"
  ) {
    for (const u of resolver.uses) {
      if (u.position === "write" && masksFor(policy, u.relation)) {
        throw deny(`it changes the schema of masked table \`${u.key}\``);
      }
    }
  }
  for (const v of resolver.viewUses) {
    if (masksFor(policy, v.relation)) {
      throw deny(
        `view \`${v.view}\` reads masked table \`${v.key}\`, and masks can't be applied inside a view; query the table directly`,
      );
    }
  }
  for (const u of resolver.uses) {
    if (
      u.node === null &&
      u.position === "read" &&
      masksFor(policy, u.relation)
    ) {
      throw deny(`a schema change references masked table \`${u.key}\``);
    }
  }
}

/**
 * The untrusted columns among `sources` whose values reach the agent
 * readable, deduplicated into `out` in order.
 */
export function taintSources(
  policy: DatabasePolicy,
  catalog: CatalogIndex,
  sources: Iterable<BaseColumn>,
  out: TaintSource[] = [],
): TaintSource[] {
  for (const s of sources) {
    const relation = catalog.get(s.schema, s.table);
    const table = relationKey(s.schema, s.table);
    const keys = [table];
    if (relation?.parent)
      keys.push(relationKey(relation.parent.schema, relation.parent.name));
    // A parent's rows include its partitions', and their labels.
    for (const c of catalog.childrenOf(s.schema, s.table)) {
      keys.push(relationKey(c.schema, c.name));
    }
    const untrusted = keys.some((k) =>
      policy.labels.untrusted_columns[k]?.includes(s.column),
    );
    if (!untrusted) continue;
    // A mask that destroys the text leaves nothing to follow; partial doesn't.
    const entry = relation ? masksFor(policy, relation) : null;
    const rule = entry ? ruleFor(entry, s.column) : "none";
    if (rule !== "none" && !(typeof rule === "object" && rule.t === "partial"))
      continue;
    if (!out.some((t) => t.table === table && t.column === s.column)) {
      out.push({ table, column: s.column });
    }
  }
  return out;
}
