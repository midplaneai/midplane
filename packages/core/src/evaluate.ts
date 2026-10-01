// One statement plus context in, one verdict out. Fixed stages; the first
// denial reached is the answer. No clock, no randomness, no I/O: the same
// input always produces the same evaluation.

import { approvalKey } from "./approval.ts";
import { CatalogIndex } from "./catalog.ts";
import {
  checkAccess,
  checkScope,
  decide,
  taintSources,
  untrustedTouched,
} from "./decide.ts";
import { Deny, unsupported } from "./deny.ts";
import { isVolatile } from "./functions.ts";
import { fingerprint, parseOne, parseSelect } from "./parse.ts";
import { coverageGap, Resolver } from "./resolve.ts";
import {
  buildPreview,
  deparse,
  masksFor,
  rewrite,
  ruleFor,
} from "./rewrite.ts";
import { analyze, classify } from "./statement.ts";
import type {
  Effects,
  EvaluateInput,
  Evaluation,
  ExecutionPlan,
  TaintSource,
} from "./types.ts";

export function evaluate(input: EvaluateInput): Evaluation {
  const tables: string[] = [];
  const touch = (key: string) => {
    if (!tables.includes(key)) tables.push(key);
  };
  let fp: string | null = null;
  const effects = (
    sources: TaintSource[] = [],
    dependsOnTaint = false,
    readsUntrusted = false,
    masked = false,
  ): Effects => ({
    taints: sources.length > 0,
    taintSources: sources,
    dependsOnTaint,
    readsUntrusted,
    masked,
    tables: [...tables],
    fingerprint: fp,
  });

  try {
    // 1. Parse: exactly one statement.
    fp = fingerprint(input.sql);
    const stmt = parseOne(input.sql);

    // 2. Classify, then check the caller may read or write this database.
    const classification = classify(stmt);
    checkScope(input, classification.write !== null);

    // 3. Resolve every name; table access is checked as each relation binds.
    const catalog = new CatalogIndex(input.catalog);
    const resolver = new Resolver(catalog, {
      onRelation(use) {
        touch(use.key);
        checkAccess(
          input.policy,
          use.relation.schema,
          use.relation.name,
          use.position,
          use.relation.parent,
        );
      },
    });
    resolver.parseDefinition = parseSelect;
    const analysis = analyze(stmt, resolver, {
      onCreate(creation) {
        touch(creation.key);
        checkAccess(input.policy, creation.schema, creation.name, "write");
      },
    });
    const gap = coverageGap(stmt, resolver.visited);
    if (gap) throw unsupported(`a ${gap} Midplane could not analyze`);

    // 4. Decide.
    const decision = decide(input, catalog, classification, analysis, resolver);

    // 5. Rewrite: masks at the source, then deparse if anything changed.
    const { changed } = rewrite(stmt, resolver, analysis, input.policy);
    const outputColumns = analysis.output.map((c) => ({
      name: c.name,
      sources: [...c.lineage],
    }));
    const plan: ExecutionPlan = {
      readOnly: classification.write === null,
      statement: changed ? deparse(stmt) : input.sql,
      ...(input.policy.role ? { role: input.policy.role } : {}),
      statementTimeoutMs: input.policy.limits.statement_timeout_ms,
      lockTimeoutMs: input.policy.limits.lock_timeout_ms,
      outputColumns,
    };
    // Returned values taint; so do values a write stores, or untrusted text
    // could be copied into an unlabeled column and read back clean.
    const sources: TaintSource[] = [];
    for (const c of analysis.output)
      taintSources(input.policy, catalog, c.lineage, sources);
    taintSources(input.policy, catalog, resolver.written, sources);
    const untrusted = untrustedTouched(input.policy, catalog, resolver);
    // What comes back passes through a mask: any output value whose source
    // column has a rule other than "none", an unreviewed one included.
    const masked = analysis.output.some((c) =>
      c.lineage.some((b) => {
        const r = catalog.get(b.schema, b.table);
        const entry = r ? masksFor(input.policy, r) : null;
        return entry !== null && ruleFor(entry, b.column) !== "none";
      }),
    );

    if (decision.action === "hold" && classification.write) {
      return {
        verdict: "hold",
        class: classification.write.class,
        cause: decision.cause,
        approvalKey: approvalKey({
          databaseId: input.databaseId,
          sql: input.sql,
          intent: input.intent,
          grantId: input.caller.grant_id,
        }),
        preview: buildPreview(
          stmt,
          analysis,
          resolver.functions.some((f) => isVolatile(f.name)),
        ),
        plan,
        effects: effects(sources, decision.dependsOnTaint, untrusted, masked),
      };
    }
    return {
      verdict: "allow",
      plan,
      effects: effects(sources, decision.dependsOnTaint, untrusted, masked),
    };
  } catch (err) {
    if (err instanceof Deny) {
      return {
        verdict: "deny",
        rule: err.rule,
        reason: err.reason,
        effects: effects(),
      };
    }
    throw err;
  }
}
