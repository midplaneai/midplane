// Cross-dialect corpus runner.
//
// Builds a Postgres engine and a MySQL engine over the SAME shared policy and
// asserts every corpus case's verdict on both. This is the load-bearing proof
// of Phase 1: the rules are byte-unchanged from the PG-only build, yet a MySQL
// DB gets the identical decision for the identical query. A divergence here
// means the MySQL adapter's IR doesn't match the PG adapter's for some shape —
// a real bug, surfaced before it can become a silent bypass.
//
// Verdicts flow through MemoryAuditWriter, so they are also captured into the
// verdict baseline (PG tuples must stay byte-identical to the pre-PR baseline;
// MySQL tuples are recorded fresh).

import { describe, expect, test } from "bun:test";
import { Engine } from "../../src/engine.ts";
import { postgresDialect } from "../../src/dialects/postgres/index.ts";
import { createMysqlDialect } from "../../src/dialects/mysql/index.ts";
import type { Dialect, DialectName } from "../../src/dialects/types.ts";
import { parseError } from "../../src/policy/rules/parse-error.ts";
import { multiStatement } from "../../src/policy/rules/multi-statement.ts";
import { tableAccess, type TableAccessConfig } from "../../src/policy/rules/table-access.ts";
import { tenantScope, type TenantScopeConfig } from "../../src/policy/rules/tenant-scope.ts";
import { MemoryAuditWriter, MockExecutor, StubCredentialStore } from "../_helpers.ts";
import {
  SHARED_CORPUS,
  CORPUS_TABLE_ACCESS,
  CORPUS_TENANT_SCOPE,
  CORPUS_TENANT_ID,
  CORPUS_MYSQL_DATABASE,
} from "./_corpus-shared.ts";

function makeEngine(dialect: Dialect, ta: TableAccessConfig, ts: TenantScopeConfig): Engine {
  let counter = 0;
  return new Engine({
    policy: {
      rules: [
        parseError(),
        multiStatement(),
        tableAccess(() => ta),
        tenantScope((): TenantScopeConfig => ts),
      ],
    },
    audit: new MemoryAuditWriter(),
    credentials: new StubCredentialStore(),
    executor: new MockExecutor(),
    dialect,
    now: () => 1_700_000_000_000,
    idGen: () => `01TESTID${(counter++).toString().padStart(18, "0")}`,
  });
}

const DIALECTS: Record<DialectName, Dialect> = {
  postgres: postgresDialect,
  mysql: createMysqlDialect({ database: CORPUS_MYSQL_DATABASE }),
};

const ctx = {
  tenant_id: CORPUS_TENANT_ID,
  agent_name: "corpus",
  agent_version: "0.0.1",
  mcp_token_id: null,
  role: "agent_readonly",
};

describe("cross-dialect corpus: identical verdicts from the same rules", () => {
  for (const dialectName of Object.keys(DIALECTS) as DialectName[]) {
    const engine = makeEngine(DIALECTS[dialectName], CORPUS_TABLE_ACCESS, CORPUS_TENANT_SCOPE);

    describe(`dialect=${dialectName}`, () => {
      for (const c of SHARED_CORPUS) {
        const sql = c.sql[dialectName];
        if (sql === null) continue; // dialect-specific skip
        test(c.name, async () => {
          const d = await engine.handle({ sql, ctx });
          if (c.expect.decision === "ALLOW") {
            expect(d.allowed).toBe(true);
          } else {
            expect(d.allowed).toBe(false);
            expect((d as { allowed: false; reason: string }).reason).toBe(c.expect.reason);
          }
        });
      }
    });
  }
});
