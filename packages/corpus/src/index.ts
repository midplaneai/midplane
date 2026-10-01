// @midplane/corpus: fixtures of SQL, policy and catalog in, expected evaluation
// out. The corpus is data, not code: every file under fixtures/ is a JSON
// document validated by FixtureFileSchema, and any evaluator (the core's
// tests, the cloud's simulator, the gateway end to end) can replay it.

import { readdirSync, readFileSync } from "node:fs";
import {
  ApprovalClassSchema,
  type CallerClaims,
  CallerClaimsSchema,
  type CatalogSnapshot,
  CatalogSnapshotSchema,
  type DatabasePolicy,
  DatabasePolicySchema,
  HoldCauseSchema,
  RuleIdSchema,
} from "@midplane/protocol";
import { z } from "zod";

const ExpectationSchema = z.strictObject({
  verdict: z.enum(["allow", "hold", "deny"]),
  rule: RuleIdSchema.optional(),
  class: ApprovalClassSchema.optional(),
  /** Why a hold holds: its class, or only the grant's taint. */
  cause: HoldCauseSchema.optional(),
  /** Substring of the denial reason. */
  reason_includes: z.string().min(1).optional(),
  /** The exact statement the plan executes. */
  statement: z.string().optional(),
  /** Substrings the executed statement must contain. */
  statement_includes: z.array(z.string()).optional(),
  /** Substrings the executed statement must not contain. */
  statement_excludes: z.array(z.string()).optional(),
  read_only: z.boolean().optional(),
  taints: z.boolean().optional(),
  /** The untrusted columns behind `taints`, as `schema.table.column`, in order. */
  taint_sources: z.array(z.string()).optional(),
  /** Whether the grant's taint could change the verdict. */
  depends_on_taint: z.boolean().optional(),
  reads_untrusted: z.boolean().optional(),
  tables: z.array(z.string()).optional(),
  /** Output fields with their sources as `schema.table.column`. */
  output: z
    .array(z.strictObject({ name: z.string(), sources: z.array(z.string()) }))
    .optional(),
  preview: z
    .strictObject({ sql: z.string().optional(), exact: z.boolean().optional() })
    .nullable()
    .optional(),
});
export type Expectation = z.infer<typeof ExpectationSchema>;

const CaseSchema = z.strictObject({
  name: z.string().optional(),
  sql: z.string(),
  policy: z.string().optional(),
  /** Replaces the caller's scopes; the rest of the caller stays. */
  scopes: z.array(z.string()).optional(),
  tainted: z.boolean().optional(),
  intent: z.string().optional(),
  expect: ExpectationSchema,
  /** Where the case came from, e.g. the old engine test it was converted from. */
  origin: z.string().optional(),
});

const FixtureFileSchema = z.strictObject({
  description: z.string(),
  /** A file in catalogs/, without the extension. */
  catalog: z.string(),
  policies: z.record(z.string(), z.unknown()),
  defaults: z.strictObject({
    policy: z.string(),
    tainted: z.boolean().default(false),
  }),
  cases: z.array(CaseSchema).min(1),
});

/** The caller every case runs as, unless it overrides the scopes. */
export const DEFAULT_CALLER: CallerClaims = {
  sub: "user-1",
  client_id: "client-1",
  grant_id: "grant-1",
  scopes: ["db:main:write"],
};

export const DEFAULT_DATABASE_ID = "main";

export interface CorpusCase {
  /** `file#index`, stable across runs. */
  id: string;
  name: string;
  input: {
    sql: string;
    databaseId: string;
    policy: DatabasePolicy;
    catalog: CatalogSnapshot;
    caller: CallerClaims;
    tainted: boolean;
    intent: string;
  };
  expect: Expectation;
}

const root = new URL("../", import.meta.url);

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8"));
}

/** Every case in fixtures/, in file then case order. */
export function loadCorpus(): CorpusCase[] {
  const catalogs = new Map<string, CatalogSnapshot>();
  const catalog = (name: string): CatalogSnapshot => {
    let c = catalogs.get(name);
    if (!c) {
      c = CatalogSnapshotSchema.parse(
        readJson(new URL(`catalogs/${name}.json`, root)),
      );
      catalogs.set(name, c);
    }
    return c;
  };

  const out: CorpusCase[] = [];
  const files = readdirSync(new URL("fixtures/", root))
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const doc = FixtureFileSchema.parse(
      readJson(new URL(`fixtures/${file}`, root)),
    );
    const policies = new Map<string, DatabasePolicy>();
    for (const [name, raw] of Object.entries(doc.policies)) {
      const parsed = DatabasePolicySchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `${file}: policy "${name}" is invalid: ${parsed.error.message}`,
        );
      }
      policies.set(name, parsed.data);
    }
    const snapshot = catalog(doc.catalog);
    doc.cases.forEach((c, index) => {
      const policyName = c.policy ?? doc.defaults.policy;
      const policy = policies.get(policyName);
      if (!policy)
        throw new Error(`${file}#${index}: unknown policy "${policyName}"`);
      const caller = CallerClaimsSchema.parse({
        ...DEFAULT_CALLER,
        ...(c.scopes ? { scopes: c.scopes } : {}),
      });
      out.push({
        id: `${file.replace(/\.json$/, "")}#${index}`,
        name: c.name ?? c.sql,
        input: {
          sql: c.sql,
          databaseId: DEFAULT_DATABASE_ID,
          policy,
          catalog: snapshot,
          caller,
          tainted: c.tainted ?? doc.defaults.tainted,
          intent: c.intent ?? "",
        },
        expect: c.expect,
      });
    });
  }
  return out;
}
