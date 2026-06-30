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
  | { ok: true; sql: string; maskedColumns: string[] }
  | { ok: false; reason: string };

/** Covert-channel SHAPE gate result — `ok` carries the allowlisted bare function
 *  names the statement used, to feed the per-connection shadow scan (stage 2). */
export type ShapeOutcome =
  | { ok: true; allowlistedFns: string[] }
  | { ok: false; reason: string };

/** Per-connection gate result (shadow scan). */
export type GateOutcome = { ok: true } | { ok: false; reason: string };

/** The dialect-supplied masking seam (eng-review A1: the AST rewrite + the
 *  covert-channel gate, which both name dialect AST nodes / dialect builtins, live
 *  in the dialect, not here). The Postgres impl is the span-splice proven in the
 *  Phase-0 spike (`.context/spike-emission/`) + the ET2 mask-safety gate. */
export interface SourceRewriter {
  /** Parse the statement and return the base-relation references that need catalog
   *  resolution. Cheap, sync, no DB. */
  collectRefs(sql: string): RelationRef[];
  /** Rewrite the statement, wrapping each masked relation in its masking subquery
   *  using the resolved catalog. Fail closed (ok:false) on anything unprovable:
   *  view/foreign relkind, unresolved ref, schema-qualified column ref on a wrapped
   *  table, out-of-domain transform, emission failure. `maskedColumns` lists the
   *  `schema.table.col` refs actually wrapped (for the EXECUTED audit). */
  rewrite(sql: string, masks: ColumnMasks, catalog: ByNameCatalog): RewriteOutcome;
  /** Covert-channel SHAPE gate (sync, AST-only) — deny-by-default function/operator
   *  allowlist. Runs in the policy phase so a reject avoids opening the txn. */
  checkShape(sql: string): ShapeOutcome;
  /** Covert-channel SHADOW scan (per-connection) — verify no allowlisted builtin
   *  name is shadowed by a user-schema function. Runs inside the rewrite txn. */
  shadowScan(tx: TxClient, names: string[]): Promise<GateOutcome>;
}

export interface SourceRewriteDeps {
  executor: Executor;
  rewriter: SourceRewriter;
  columnMasks: ColumnMasks;
  salt: string;
  /** Allowlisted bare function names from the SHAPE gate, for the shadow scan. */
  shadowNames: string[];
}

export type SourceRewriteResult =
  | { ok: true; result: ExecutionResult; maskedColumns: string[] }
  | { ok: false; reason: string };

/** Run a statement through the source-rewrite path on one transaction-scoped
 *  client. Returns `null` when the executor has no `withTransaction` support — the
 *  caller then falls back to the retained post-exec masker (the rollback path). */
export async function runSourceRewrite(
  sql: string,
  ctx: ExecuteContext,
  deps: SourceRewriteDeps,
): Promise<SourceRewriteResult | null> {
  const { executor, rewriter, columnMasks, salt, shadowNames } = deps;
  if (!executor.withTransaction) return null;

  return executor.withTransaction(ctx, async (tx): Promise<SourceRewriteResult> => {
    // 1. Salt: set + verify on THIS client, fresh, before anything else.
    try {
      await setMaskSalt(tx, salt);
    } catch (e) {
      if (e instanceof MaskSaltError) return { ok: false, reason: e.message };
      throw e; // infra error -> ROLLBACK + propagate
    }

    // 2. Covert-channel SHADOW scan on this client: no allowlisted builtin name is
    //    shadowed by a user-schema UDF (the SHAPE gate already ran in the policy
    //    phase). Fail closed.
    const sc = await rewriter.shadowScan(tx, shadowNames);
    if (!sc.ok) return { ok: false, reason: sc.reason };

    // 3. Resolve referenced relations by name on this client (shared search_path).
    const refs = rewriter.collectRefs(sql);
    const catalog = await buildCatalogByName((s, p) => tx.query(s, p), refs);

    // 4. Rewrite (dialect span-splice). Fail closed on reject.
    const out = rewriter.rewrite(sql, columnMasks, catalog);
    if (!out.ok) return { ok: false, reason: out.reason };

    // 5. Execute the rewritten SQL on the same client.
    return { ok: true, result: await tx.exec(out.sql), maskedColumns: out.maskedColumns };
  });
}
