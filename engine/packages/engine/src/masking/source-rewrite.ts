// Source-rewrite coordinator (masking, T0).
//
// Orchestrates the source-rewrite enforcement path on ONE transaction-scoped
// client (Executor.withTransaction): set + verify the mask salt, resolve the
// referenced relations by name, hand off to the dialect's rewriter (span-splice),
// and execute the rewritten SQL — all on the same backend. Engine-side and
// dialect-agnostic: the actual AST rewrite (which names RangeVar/RangeSubselect)
// is injected via SourceRewriter, whose Postgres implementation lives in
// dialects/postgres (eng-review A1).
//
// Fail-closed throughout: an empty/absent salt, an unresolvable relation, or any
// rewriter reject withholds the rows (returns { ok:false }); the engine maps that
// to a column_masking denial, never a raw passthrough.
//
//   handle() ─▶ runSourceRewrite ─▶ withTransaction(one client):
//                 1. set+verify salt (set_config, txn-local)   ── fail-closed
//                 2. buildCatalogByName(refs) on this client   ── shared search_path
//                 3. rewriter.rewrite(sql, masks, catalog)     ── dialect span-splice
//                 4. tx.exec(rewrittenSql)                     ── same backend
//   returns null ⇒ executor has no txn support ⇒ caller uses post-exec masker.

import type { ExecuteContext, ExecutionResult, Executor, TxClient } from "../executor.ts";
import type { ColumnMasks } from "./mask-result-set.ts";
import { buildCatalogByName, type ByNameCatalog, type RelationRef } from "./catalog.ts";

// Custom GUC carrying the per-(project|database) mask salt. Set transaction-locally
// via set_config(.., true) at the start of EVERY rewrite transaction — never trust
// prior connection state. A custom GUC reverts to '' (NOT undefined) after a prior
// SET LOCAL, so a pooled connection that skips this would read '' and silently
// produce an UNSALTED, rainbow-tableable hash (verified, Phase-0 spike). See the
// reference note pg-custom-guc-empty-not-undefined.
export const MASK_SALT_GUC = "midplane.mask_salt";

/** Thrown when the mask salt is empty or did not apply to the transaction — a
 *  fail-closed condition the coordinator turns into a reject, never a leak. */
export class MaskSaltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaskSaltError";
  }
}

/** Set the mask salt transaction-locally and verify it stuck and is non-empty.
 *  `set_config(name, value, true)` is transaction-scoped and returns the applied
 *  value, so the verify is a single round-trip on the SAME client. Always called
 *  fresh per rewrite transaction — that is what defeats the pooled-GUC-reverts-to-''
 *  leak (we never read a salt we didn't just set). */
export async function setMaskSalt(tx: TxClient, salt: string): Promise<void> {
  if (!salt) throw new MaskSaltError("mask salt is empty"); // config bug -> fail closed
  const rows = await tx.query("SELECT set_config($1, $2, true) AS v", [MASK_SALT_GUC, salt]);
  if (rows[0]?.v !== salt) {
    throw new MaskSaltError("mask salt did not apply to the transaction");
  }
}

export type RewriteOutcome =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

/** The dialect-supplied rewriter seam (eng-review A1: the AST rewrite that names
 *  RangeVar/RangeSubselect lives in the dialect, not here). The Postgres impl is
 *  the span-splice proven in the Phase-0 spike (`.context/spike-emission/`). */
export interface SourceRewriter {
  /** Parse the statement and return the base-relation references that need catalog
   *  resolution. Cheap, sync, no DB. */
  collectRefs(sql: string): RelationRef[];
  /** Rewrite the statement, wrapping each masked relation in its masking subquery
   *  using the resolved catalog. Fail closed (ok:false) on anything unprovable:
   *  view/foreign relkind, unresolved ref, off-allowlist function/operator,
   *  schema-qualified column ref on a wrapped table, emission failure. */
  rewrite(sql: string, masks: ColumnMasks, catalog: ByNameCatalog): RewriteOutcome;
}

export interface SourceRewriteDeps {
  executor: Executor;
  rewriter: SourceRewriter;
  columnMasks: ColumnMasks;
  salt: string;
}

export type SourceRewriteResult =
  | { ok: true; result: ExecutionResult }
  | { ok: false; reason: string };

/** Run a statement through the source-rewrite path on one transaction-scoped
 *  client. Returns `null` when the executor has no `withTransaction` support — the
 *  caller then falls back to the retained post-exec masker (the rollback path). */
export async function runSourceRewrite(
  sql: string,
  ctx: ExecuteContext,
  deps: SourceRewriteDeps,
): Promise<SourceRewriteResult | null> {
  const { executor, rewriter, columnMasks, salt } = deps;
  if (!executor.withTransaction) return null;

  return executor.withTransaction(ctx, async (tx): Promise<SourceRewriteResult> => {
    // 1. Salt: set + verify on THIS client, fresh, before anything else.
    try {
      await setMaskSalt(tx, salt);
    } catch (e) {
      if (e instanceof MaskSaltError) return { ok: false, reason: e.message };
      throw e; // infra error -> ROLLBACK + propagate
    }

    // 2. Resolve referenced relations by name on this client (shared search_path).
    const refs = rewriter.collectRefs(sql);
    const catalog = await buildCatalogByName((s, p) => tx.query(s, p), refs);

    // 3. Rewrite (dialect span-splice). Fail closed on reject.
    const out = rewriter.rewrite(sql, columnMasks, catalog);
    if (!out.ok) return { ok: false, reason: out.reason };

    // 4. Execute the rewritten SQL on the same client.
    return { ok: true, result: await tx.exec(out.sql) };
  });
}
