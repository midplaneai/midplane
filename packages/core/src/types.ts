import type {
  ApprovalClass,
  CallerClaims,
  CatalogSnapshot,
  DatabasePolicy,
  HoldCause,
  RuleId,
} from "@midplane/protocol";
import type { BaseColumn } from "./resolve.ts";

export type { BaseColumn };

export interface EvaluateInput {
  /** One statement; its raw bytes are what an approval binds. */
  sql: string;
  /** The database the statement targets; scopes and approvals bind to it. */
  databaseId: string;
  /** From the bundle, schema-validated. */
  policy: DatabasePolicy;
  catalog: CatalogSnapshot;
  caller: CallerClaims;
  /** From the cloud's taint record for this grant. */
  tainted: boolean;
  /** The agent's stated reason; part of the approval binding. */
  intent: string;
}

/** An output field and the base columns its value comes from. */
export interface ResolvedColumn {
  name: string;
  sources: BaseColumn[];
}

export interface ExecutionPlan {
  readOnly: boolean;
  /** The statement to execute: rewritten when masks or qualification apply. */
  statement: string;
  /** `SET LOCAL ROLE` target. */
  role?: string;
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  outputColumns: ResolvedColumn[];
}

/** A base column labeled untrusted whose value reaches the agent or is stored. */
export interface TaintSource {
  /** `schema.table`. */
  table: string;
  column: string;
}

export interface Effects {
  /**
   * True when the result carries a value from a column labeled untrusted, or
   * the statement stores one: running it taints the grant.
   */
  taints: boolean;
  /** The untrusted columns behind `taints`, in first-reference order. */
  taintSources: TaintSource[];
  /**
   * True when the grant's taint could change the verdict: the statement
   * touches a table labeled secret, or it is a write its class allows
   * (taint would hold it). Always false on a denial.
   */
  dependsOnTaint: boolean;
  /**
   * True when the statement touches a table with columns labeled untrusted,
   * itself, through its parent or through a partition: an error Postgres
   * raises can quote one of its values. Always false on a denial.
   */
  readsUntrusted: boolean;
  /**
   * True when a returned value passes through a mask: its source column has
   * a rule other than `none`, an unreviewed column's full redaction
   * included. Always false on a denial.
   */
  masked: boolean;
  /** Relations the statement names, `schema.table`, in first-reference order. */
  tables: string[];
  /** libpg_query fingerprint; null when the statement didn't parse. */
  fingerprint: string | null;
}

/** A SELECT counting the rows a held write would change. */
export interface Preview {
  sql: string;
  /** False when the write may change fewer rows (ON CONFLICT). */
  exact: boolean;
}

export type Evaluation =
  | { verdict: "deny"; rule: RuleId; reason: string; effects: Effects }
  | {
      verdict: "hold";
      class: ApprovalClass;
      /** The policy holds the class, or only the grant's taint holds it. */
      cause: HoldCause;
      approvalKey: string;
      preview: Preview | null;
      plan: ExecutionPlan;
      effects: Effects;
    }
  | { verdict: "allow"; plan: ExecutionPlan; effects: Effects };
