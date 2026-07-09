// Unit coverage for the projects lib.
//
// deleteProject: cleanup invariant — no orphan indexer_cursors rows.
// rotateProject: critical path — DB write atomicity AND in-memory cache
//   invalidation must both fire on the happy path. Failure to invalidate
//   either DecryptCache or ContainerRegistry means a rotated DSN keeps
//   serving the OLD credentials until the 30-min idle timer fires (security
//   incident). The 404 path proves we don't touch caches when ownership
//   doesn't match. The failure-isolation case proves a cache layer throwing
//   doesn't strand the registry layer (the durable fact is "DSN rotated").
//
// 0008 schema split: the credential row moved to project_databases.
// Rotation now selects the parent (for ownership + token + region) and
// updates the child (for the DSN ciphertext + rotated_at). DecryptCache
// invalidation keys per-credential — the test asserts the child's id is
// passed to cache.invalidate, not the parent id.
//
// All mocks are shape-only — no real Postgres or KMS contact, so the suite
// runs in vitest's plain node env.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ColumnMasksConfig } from "@midplane-cloud/db";
// Static import is safe here: plan.ts is pure at module top (its only heavy
// dependency, customer.ts, loads lazily inside resolvePlan, which these
// tests never call).
import { DatabaseLimitError } from "../src/lib/plan.ts";

interface DbCall {
  op: "delete" | "update" | "select" | "insert" | "execute";
  table?: unknown;
  set?: unknown;
  where?: unknown;
  returning?: Record<string, unknown>;
}

interface FakeDbHandle {
  db: object;
  calls: DbCall[];
  /** Result of a parent-table select (rotateProject's ownership check
   *  reads projects, returning {id, region}). PR2 of
   *  mcp_url_auth_security: parent rows no longer carry mcp_token — the
   *  agent-facing surface lives in the mcp_tokens table. */
  setParentSelectResult(
    rows: Array<{ id: string; region?: string }>,
  ): void;
  /** Result of a project_databases UPDATE…RETURNING (rotateProject
   *  needs the child id to feed DecryptCache.invalidate). */
  setChildUpdateResult(rows: Array<{ id: string }>): void;
  /** Result of a projects DELETE…RETURNING (deleteProject — returns
   *  just {id} since PR2; registry keys on project id, not token). */
  setProjectsReturning(rows: Array<{ id: string }>): void;
  /** Result of a projects UPDATE…RETURNING that sets `pausedAt`
   *  (pauseProject / resumeProject). Non-empty = the WHERE matched an
   *  owned row; empty = foreign/unknown id → the lib returns null. */
  setProjectUpdateResult(rows: Array<{ id: string }>): void;
  /** Push the result for the NEXT select() call. Drains in FIFO order;
   *  once empty, selects fall back to setParentSelectResult. Lets
   *  multi-select helpers (addDatabase: parent + sibling-collision;
   *  removeDatabase: parent + sibling count) stage each read
   *  independently. */
  queueSelect(rows: unknown[]): void;
  /** Result of a project_databases DELETE…RETURNING (removeDatabase).
   *  Distinct from projects DELETE so the two helpers don't share
   *  fixture state. */
  setChildDeleteResult(rows: Array<{ id: string }>): void;
  /** Make the next insert reject with the given error. Used to simulate
   *  the race-loser path on add/rename where the FOR UPDATE lock has
   *  somehow been bypassed and the unique constraint trips. */
  failNextInsert(err: unknown): void;
  /** Make the next update reject with the given error. Same role as
   *  failNextInsert but for the rename path (UPDATE SET name=?). */
  failNextUpdate(err: unknown): void;
}

let handle: FakeDbHandle;

function makeFakeDb(): FakeDbHandle {
  let parentSelect: Array<{
    id: string;
    region?: string;
  }> = [];
  let childUpdate: Array<{ id: string }> = [];
  let childDelete: Array<{ id: string }> = [];
  let childDeleteSet = false;
  let projectUpdate: Array<{ id: string }> = [];
  let deletedProjects: Array<{ id: string }> = [];
  const selectQueue: Array<unknown[]> = [];
  const calls: DbCall[] = [];
  const insertErrorQueue: unknown[] = [];
  const updateErrorQueue: unknown[] = [];

  const makeRoot = () => {
    const startMutation = (op: "delete" | "update", table: unknown) => {
      let setValue: unknown;
      let whereValue: unknown;
      const chain = {
        set(v: unknown) {
          setValue = v;
          return chain;
        },
        where(c: unknown) {
          whereValue = c;
          return chain;
        },
        returning(fields: Record<string, unknown>) {
          calls.push({
            op,
            table,
            set: setValue,
            where: whereValue,
            returning: fields,
          });
          if (op === "update" && updateErrorQueue.length > 0) {
            return Promise.reject(updateErrorQueue.shift());
          }
          if (op === "delete") {
            // Distinguish deletes on `projects` (deleteProject,
            // returning {id}) from deletes on `project_databases`
            // (removeDatabase, also returning {id}).
            // We use an explicit "did the test set childDelete?" flag
            // so an empty array is honored — necessary for the
            // "dbName not on project" path where the delete really
            // does match 0 rows.
            if (childDeleteSet) return Promise.resolve(childDelete);
            return Promise.resolve(deletedProjects);
          }
          const set = setValue as Record<string, unknown> | undefined;
          // Child updates on project_databases set the credential
          // columns (rotateProject), the policy column
          // (setTableAccess), the alias column (renameDatabase via
          // {name}), the tenant_scope config, or the guardrails config.
          // Parent updates on projects only set {name} via
          // renameProject — but since the test never exercises that
          // simultaneously with a child rename, prefer childUpdate when
          // populated.
          if (
            set &&
            ("encryptedDsn" in set ||
              "tableAccess" in set ||
              "tenantScope" in set ||
              "guardrails" in set ||
              "ignoredColumns" in set)
          ) {
            return Promise.resolve(childUpdate);
          }
          if (set && "name" in set && childUpdate.length > 0) {
            // renameDatabase update: set {name}, returning {id}.
            return Promise.resolve(childUpdate);
          }
          if (set && "pausedAt" in set) {
            // pauseProject / resumeProject update on projects.
            return Promise.resolve(projectUpdate);
          }
          return Promise.resolve([]);
        },
        then(onFulfilled: (rows: unknown[]) => unknown) {
          // Used by the cursor delete which doesn't call .returning().
          calls.push({ op, table, set: setValue, where: whereValue });
          return Promise.resolve([]).then(onFulfilled);
        },
      };
      return chain;
    };

    const startSelect = () => {
      let table: unknown;
      let whereValue: unknown;
      const resolveRows = () =>
        selectQueue.length > 0 ? selectQueue.shift()! : parentSelect;
      const chain = {
        from(t: unknown) {
          table = t;
          return chain;
        },
        where(c: unknown) {
          whereValue = c;
          return chain;
        },
        leftJoin() {
          return chain;
        },
        innerJoin() {
          return chain;
        },
        groupBy() {
          return chain;
        },
        for() {
          // SELECT ... FOR UPDATE — the fake doesn't model row locks,
          // but the chain method has to exist so the helpers can call
          // it. Concurrency behavior is verified at the integration
          // layer (against a real Postgres); this no-op is enough for
          // shape testing.
          return chain;
        },
        limit() {
          calls.push({ op: "select", table, where: whereValue });
          return Promise.resolve(resolveRows());
        },
        orderBy() {
          return chain;
        },
        then(onFulfilled: (rows: unknown[]) => unknown) {
          calls.push({ op: "select", table, where: whereValue });
          return Promise.resolve(resolveRows()).then(onFulfilled);
        },
      };
      return chain;
    };

    const startInsert = (table: unknown) => {
      const chain = {
        values(row: unknown) {
          calls.push({ op: "insert", table, set: row });
          if (insertErrorQueue.length > 0) {
            return Promise.reject(insertErrorQueue.shift());
          }
          // Insert is fire-and-forget (the lib generates ULIDs outside
          // the txn and doesn't .returning() — addDatabase tracks the
          // child id from outside). Resolve void to mirror Drizzle.
          return Promise.resolve();
        },
      };
      return chain;
    };

    return {
      delete(t: unknown) {
        return startMutation("delete", t);
      },
      update(t: unknown) {
        return startMutation("update", t);
      },
      select(_fields?: unknown) {
        return startSelect();
      },
      insert(t: unknown) {
        return startInsert(t);
      },
      // SET LOCAL app.customer_id (RLS bind) reaches the driver via
      // tx.execute(sql.raw(...)). The fake doesn't model RLS — we just
      // record the raw SQL text so audit-emission tests can assert the
      // bind fired. Drizzle's sql.raw stashes the string in
      // queryChunks[0].value[0]; we extract it for stable comparison.
      async execute(stmt: unknown) {
        const chunks = (stmt as { queryChunks?: Array<{ value?: unknown }> })
          ?.queryChunks;
        const raw =
          chunks && Array.isArray(chunks) && chunks.length > 0
            ? Array.isArray((chunks[0] as { value?: unknown }).value)
              ? ((chunks[0] as { value: unknown[] }).value[0] as string)
              : String((chunks[0] as { value?: unknown }).value ?? "")
            : "";
        calls.push({ op: "execute", set: raw });
        return { rows: [] };
      },
    };
  };

  const txObj = makeRoot();
  const db = {
    async transaction<T>(fn: (tx: object) => Promise<T>): Promise<T> {
      return fn(txObj);
    },
    ...txObj,
  };

  return {
    db,
    calls,
    setParentSelectResult(rows) {
      parentSelect = rows;
    },
    setChildUpdateResult(rows) {
      childUpdate = rows;
    },
    setChildDeleteResult(rows) {
      childDelete = rows;
      childDeleteSet = true;
    },
    failNextInsert(err) {
      insertErrorQueue.push(err);
    },
    failNextUpdate(err) {
      updateErrorQueue.push(err);
    },
    queueSelect(rows) {
      selectQueue.push(rows);
    },
    setProjectsReturning(rows) {
      // Used by both deleteProject (DELETE…RETURNING on projects)
      // and setTableAccess / addDatabase / removeDatabase / renameDatabase
      // (SELECT id FROM projects for the ownership check). Same
      // fixture data, different read paths in the post-0009 (multi-DB)
      // shape; populating both keeps the existing tests working without
      // forcing each call site to pick the right setter.
      deletedProjects = rows;
      parentSelect = rows.map((r) => ({ ...r, region: "eu" }));
    },
    setProjectUpdateResult(rows) {
      projectUpdate = rows;
    },
  };
}

// Note: we use vi.importActual rather than the (orig) callback overload of
// vi.mock — vitest supports both, but vi.importActual works uniformly across
// runners and is the modern API. The mock factory replaces a few exports
// (getDb, encryptDsn) while preserving the rest (the schema tables we
// import as values).
vi.mock("@midplane-cloud/db", async () => {
  const real = await vi.importActual<typeof import("@midplane-cloud/db")>(
    "@midplane-cloud/db",
  );
  return {
    ...real,
    getDb: (_region: "eu" | "us") => handle.db,
  };
});

vi.mock("@midplane-cloud/kms", async () => {
  const real = await vi.importActual<typeof import("@midplane-cloud/kms")>(
    "@midplane-cloud/kms",
  );
  return {
    ...real,
    // Bypass KMS — return deterministic ciphertext shape so we can assert
    // the rotation path stamps the new ciphertext + key id onto the row.
    encryptDsn: vi.fn(async (_ctx, plaintext: string) => ({
      ciphertext: Buffer.from(`ct:${plaintext}`),
      kmsKeyId: `env:eu:${plaintext.length}`,
    })),
    makeKmsContext: () => ({ mode: "env", envKeys: {}, kmsKeys: {} }),
  };
});

beforeEach(() => {
  handle = makeFakeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

const customer = {
  // ULID literal — emitConfigAuditRow validates customer.id matches the
  // ULID alphabet before SET LOCAL inlines it into the SQL string. The
  // production resolver (currentCustomer) only ever returns rows whose
  // ids were generated by ulid(), but the test customer fixture has to
  // satisfy the same shape.
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  orgId: "org_clerk-1",
  email: "u@e.test",
  region: "eu" as const,
  planOverride: null,
  plan: "free" as const,
  ownerEmail: null,
  createdAt: new Date(),
};

describe("normalizeName", () => {
  it("trims whitespace, collapses empty to null, clamps overlong input", async () => {
    const { normalizeName, MAX_PROJECT_NAME_LENGTH } = await import(
      "../src/lib/projects.ts"
    );
    expect(normalizeName(null)).toBe(null);
    expect(normalizeName(undefined)).toBe(null);
    expect(normalizeName("   ")).toBe(null);
    expect(normalizeName("  prod db  ")).toBe("prod db");
    const long = "x".repeat(MAX_PROJECT_NAME_LENGTH + 20);
    expect(normalizeName(long)).toHaveLength(MAX_PROJECT_NAME_LENGTH);
  });
});

describe("deleteProject", () => {
  it("returns null when nothing was deleted (no cursor delete fires)", async () => {
    handle.setProjectsReturning([]);
    const { projects, indexerCursors } = await import("@midplane-cloud/db");
    const { deleteProject } = await import("../src/lib/projects.ts");
    const result = await deleteProject(customer, "missing-id");
    expect(result).toBeNull();
    expect(handle.calls.some((c) => c.table === projects)).toBe(true);
    expect(handle.calls.some((c) => c.table === indexerCursors)).toBe(false);
  });

  it("deletes the matching indexer_cursors row when a project is removed", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    const { indexerCursors } = await import("@midplane-cloud/db");
    const { deleteProject } = await import("../src/lib/projects.ts");
    const result = await deleteProject(customer, "conn-1");
    expect(result).toMatchObject({ id: "conn-1" });
    const cursorDelete = handle.calls.find(
      (c) => c.table === indexerCursors,
    );
    expect(cursorDelete, "indexer_cursors delete must fire").toBeDefined();
  });
});

describe("pauseProject", () => {
  it("returns the row and issues a COALESCE update on projects when owned", async () => {
    handle.setProjectUpdateResult([{ id: "conn-1" }]);
    const { projects } = await import("@midplane-cloud/db");
    const { pauseProject } = await import("../src/lib/projects.ts");
    const result = await pauseProject(customer, "conn-1");
    expect(result).toMatchObject({ id: "conn-1" });
    const upd = handle.calls.find(
      (c) => c.op === "update" && c.table === projects,
    );
    expect(upd, "an UPDATE on projects must fire").toBeDefined();
    const set = upd!.set as Record<string, unknown>;
    // COALESCE(paused_at, now()) — a SQL expression, not a bare Date — so a
    // re-pause is a no-op on "paused since". The ownership WHERE (customer_id)
    // and true concurrency are integration-verified against a real Postgres.
    expect(set.pausedAt).toBeDefined();
    expect(set.pausedAt instanceof Date).toBe(false);
  });

  it("returns null for a foreign/unknown id (ownership-scoped)", async () => {
    // WHERE pins customer_id, so a foreign id matches no row → empty returning.
    handle.setProjectUpdateResult([]);
    const { pauseProject } = await import("../src/lib/projects.ts");
    const result = await pauseProject(customer, "not-mine");
    expect(result).toBeNull();
  });

  it("is idempotent — a second pause still returns the owned row", async () => {
    handle.setProjectUpdateResult([{ id: "conn-1" }]);
    const { pauseProject } = await import("../src/lib/projects.ts");
    expect(await pauseProject(customer, "conn-1")).toMatchObject({
      id: "conn-1",
    });
    // No isNull(paused_at) guard in the WHERE, so re-pausing an already-paused
    // project returns the row rather than a misleading null.
    expect(await pauseProject(customer, "conn-1")).toMatchObject({
      id: "conn-1",
    });
  });
});

describe("resumeProject", () => {
  it("clears paused_at and returns the row when owned", async () => {
    handle.setProjectUpdateResult([{ id: "conn-1" }]);
    const { projects } = await import("@midplane-cloud/db");
    const { resumeProject } = await import("../src/lib/projects.ts");
    const result = await resumeProject(customer, "conn-1");
    expect(result).toMatchObject({ id: "conn-1" });
    const upd = handle.calls.find(
      (c) => c.op === "update" && c.table === projects,
    );
    expect(upd, "an UPDATE on projects must fire").toBeDefined();
    const set = upd!.set as Record<string, unknown>;
    expect(set.pausedAt).toBeNull();
  });

  it("returns null for a foreign/unknown id (ownership-scoped)", async () => {
    handle.setProjectUpdateResult([]);
    const { resumeProject } = await import("../src/lib/projects.ts");
    const result = await resumeProject(customer, "not-mine");
    expect(result).toBeNull();
  });
});

describe("createProject plan caps", () => {
  // DSN encryption is mocked (see the @midplane-cloud/kms mock above), so
  // encryptDsn succeeds. The pepper is loaded (real, env mode) BEFORE the
  // txn — set the env so that load succeeds; the default token is inserted
  // inside the txn AFTER the cap check, so these cap-throw tests throw before
  // reaching the insert and don't stage it.
  const DSN = "postgres://u:p@host:5432/db";
  const ACTOR = "user_clerk-actor";

  beforeEach(() => {
    process.env.MIDPLANE_KMS_MODE = "env";
    process.env.MIDPLANE_TOKEN_PEPPER_EU_V1 = Buffer.alloc(32, 7).toString(
      "base64",
    );
  });

  it("throws PlanLimitError('projects') when already at the project cap", async () => {
    const { createProject } = await import("../src/lib/projects.ts");
    const { PlanLimitError, CAPS } = await import("../src/lib/plan.ts");
    // Free allows 1 project. Stage the customers FOR UPDATE select, then
    // the project-count select returning one existing row → 1 >= 1.
    handle.queueSelect([{ id: customer.id }]); // customers FOR UPDATE
    handle.queueSelect([]); // empty-project detection → none (existing project has a DB), so the create-new path runs the project cap
    handle.queueSelect([{ id: "conn-existing" }]); // project count
    const err = await createProject(customer, DSN, null, "read", ACTOR, {
      plan: "free",
      caps: CAPS.free,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanLimitError);
    expect(err.resource).toBe("projects");
    expect(err.limit).toBe(1);
  });

  it("throws PlanLimitError('tokens') when under the project cap but out of token room (D8)", async () => {
    const { createProject } = await import("../src/lib/projects.ts");
    const { PlanLimitError } = await import("../src/lib/plan.ts");
    // projects under cap (1 < 5) but the to-be-minted default has no room
    // (1 usable token >= tokens cap of 1).
    const caps = {
      projects: 5,
      databases: 10,
      tokens: 1,
      auditRetentionDays: 30,
      sso: false,
      seats: 10,
    };
    handle.queueSelect([{ id: customer.id }]); // customers FOR UPDATE
    handle.queueSelect([]); // empty-project detection → none → create-new path
    handle.queueSelect([{ id: "c1" }]); // project count → 1 < 5 ✓
    handle.queueSelect([{ id: "c1" }]); // countUsableTokens: project ids
    handle.queueSelect([{ count: 1 }]); // countUsableTokens: usable count → 1 >= 1
    const err = await createProject(customer, DSN, null, "read", ACTOR, {
      plan: "pro",
      caps,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(PlanLimitError);
    expect(err.resource).toBe("tokens");
    expect(err.limit).toBe(1);
  });

  it("inserts the default token INSIDE the project txn, not in a later one (atomic with the cap check)", async () => {
    const { createProject } = await import("../src/lib/projects.ts");
    const { CAPS } = await import("../src/lib/plan.ts");
    const { mcpTokens, projects: projectsTable } = await import(
      "@midplane-cloud/db"
    );
    // Under cap: 0 existing projects, 0 usable tokens (Free 1 conn / 5 tokens).
    handle.queueSelect([{ id: customer.id }]); // customers FOR UPDATE
    handle.queueSelect([]); // empty-project detection → none → create-new path
    handle.queueSelect([]); // project count → 0 < 1 ✓
    handle.queueSelect([]); // countUsableTokens: project ids → none → 0 < 1 ✓
    const result = await createProject(customer, DSN, null, "read", ACTOR, {
      plan: "free",
      caps: CAPS.free,
    });
    expect(result.defaultTokenPlaintext).toMatch(
      /^mp_(live|test)_[0-9a-f]{32}_/,
    );
    // The default token row was inserted as part of createProject — proving
    // the auto-mint moved into the project txn (no separate post-commit
    // mint that could race past the cap). It lands after the project insert.
    const inserts = handle.calls.filter((c) => c.op === "insert");
    const connIdx = inserts.findIndex((c) => c.table === projectsTable);
    const tokenIdx = inserts.findIndex((c) => c.table === mcpTokens);
    expect(connIdx, "project must be inserted").toBeGreaterThanOrEqual(0);
    expect(tokenIdx, "default token must be inserted").toBeGreaterThan(connIdx);
  });

  it("does NOT mint a default token when mintDefaultToken=false (OAuth-first web flow)", async () => {
    const { createProject } = await import("../src/lib/projects.ts");
    const { CAPS } = await import("../src/lib/plan.ts");
    const { mcpTokens, projectDatabases, projects: projectsTable } =
      await import("@midplane-cloud/db");
    // Under cap. With no token to mint, the token-cap check is skipped — so NO
    // countUsableTokens selects are staged. The project + first DB still insert.
    handle.queueSelect([{ id: customer.id }]); // customers FOR UPDATE
    handle.queueSelect([]); // empty-project detection → none → create-new path
    handle.queueSelect([]); // project count → 0 < 1 ✓
    const result = await createProject(
      customer,
      DSN,
      null,
      "read",
      ACTOR,
      { plan: "free", caps: CAPS.free },
      false,
    );
    expect(result.defaultTokenPlaintext).toBeNull();
    const inserts = handle.calls.filter((c) => c.op === "insert");
    expect(inserts.some((c) => c.table === projectsTable)).toBe(true);
    expect(inserts.some((c) => c.table === projectDatabases)).toBe(true);
    expect(
      inserts.some((c) => c.table === mcpTokens),
      "no default token row when mintDefaultToken=false",
    ).toBe(false);
  });

  it("succeeds WITHOUT any pepper configured when mintDefaultToken=false (codex P2)", async () => {
    // The OAuth-first web flow mints no token, so it must not depend on the
    // token-pepper KMS material at all — a region with no pepper configured
    // used to fail the create before the flag was even consulted.
    const prevPepper = process.env.MIDPLANE_TOKEN_PEPPER_EU_V1;
    delete process.env.MIDPLANE_TOKEN_PEPPER_EU_V1;
    try {
      const { createProject } = await import("../src/lib/projects.ts");
      const { CAPS } = await import("../src/lib/plan.ts");
      const { projectDatabases, projects: projectsTable } = await import(
        "@midplane-cloud/db"
      );
      handle.queueSelect([{ id: customer.id }]); // customers FOR UPDATE
      handle.queueSelect([]); // empty-project detection → none → create-new path
      handle.queueSelect([]); // project count → 0 < 1 ✓
      const result = await createProject(
        customer,
        DSN,
        null,
        "read",
        ACTOR,
        { plan: "free", caps: CAPS.free },
        false,
      );
      expect(result.defaultTokenPlaintext).toBeNull();
      const inserts = handle.calls.filter((c) => c.op === "insert");
      expect(inserts.some((c) => c.table === projectsTable)).toBe(true);
      expect(inserts.some((c) => c.table === projectDatabases)).toBe(true);
    } finally {
      if (prevPepper === undefined) {
        delete process.env.MIDPLANE_TOKEN_PEPPER_EU_V1;
      } else {
        process.env.MIDPLANE_TOKEN_PEPPER_EU_V1 = prevPepper;
      }
    }
  });

  it("reuses the customer's empty project instead of creating a second one (D7-A)", async () => {
    const { createProject } = await import("../src/lib/projects.ts");
    const { CAPS } = await import("../src/lib/plan.ts");
    const {
      projects: projectsTable,
      projectDatabases,
      mcpTokens,
    } = await import("@midplane-cloud/db");
    handle.queueSelect([{ id: customer.id }]); // customers FOR UPDATE
    handle.queueSelect([{ id: "empty-default", name: "Default" }]); // empty-project detection → FOUND (the auto-seeded Default)
    handle.queueSelect([{ id: "empty-default" }]); // countUsableTokens: project ids
    handle.queueSelect([{ count: 0 }]); // countUsableTokens: usable → 0 < 5 ✓
    const result = await createProject(customer, DSN, null, "read", ACTOR, {
      plan: "free",
      caps: CAPS.free,
    });
    // First DB + token attach to the reused empty project — NO second project
    // is inserted, so a Free customer (cap = 1, auto-seeded) is never blocked.
    expect(result.id).toBe("empty-default");
    const inserts = handle.calls.filter((c) => c.op === "insert");
    expect(inserts.some((c) => c.table === projectsTable)).toBe(false);
    expect(inserts.some((c) => c.table === projectDatabases)).toBe(true);
    expect(inserts.some((c) => c.table === mcpTokens)).toBe(true);
  });
});

describe("ensureDefaultProject", () => {
  it("seeds one empty project (no DB, no token) and is idempotent", async () => {
    const { ensureDefaultProject } = await import("../src/lib/projects.ts");
    const {
      projects: projectsTable,
      projectDatabases,
      mcpTokens,
    } = await import("@midplane-cloud/db");
    // First onboarding: no project yet → seed one empty project.
    handle.queueSelect([]); // existence check → none
    await ensureDefaultProject(customer.id, customer.region);
    const seeded = handle.calls.filter((c) => c.op === "insert");
    expect(
      seeded.some((c) => c.table === projectsTable),
      "an empty project is inserted",
    ).toBe(true);
    // Empty by construction: no database, no token minted — so it never reaches
    // the proxy / spawner zero-database invariants (the D6 safety property).
    expect(seeded.some((c) => c.table === projectDatabases)).toBe(false);
    expect(seeded.some((c) => c.table === mcpTokens)).toBe(false);
    // Second call (returning user / double-submitted onboard): a project already
    // exists → no-op, no second insert.
    const before = handle.calls.filter((c) => c.op === "insert").length;
    handle.queueSelect([{ id: "existing" }]); // existence check → found
    await ensureDefaultProject(customer.id, customer.region);
    const after = handle.calls.filter((c) => c.op === "insert").length;
    expect(after, "idempotent: no second project inserted").toBe(before);
  });
});

interface CacheSpy {
  invalidate: ReturnType<typeof vi.fn>;
}
interface RegistrySpy {
  invalidate: ReturnType<typeof vi.fn>;
}

function makeCaches(overrides?: {
  cache?: Partial<CacheSpy>;
  registry?: Partial<RegistrySpy>;
}) {
  const cache: CacheSpy = {
    invalidate: vi.fn(),
    ...overrides?.cache,
  };
  const registry: RegistrySpy = {
    invalidate: vi.fn(async () => undefined),
    ...overrides?.registry,
  };
  return { cache, registry };
}

describe("rotateProject", () => {
  it("happy path: updates project_databases ciphertext + invalidates per-credential cache + registry", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", region: "eu" },
    ]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { projectDatabases } = await import("@midplane-cloud/db");
    const { rotateProject } = await import("../src/lib/projects.ts");
    const caches = makeCaches();

    const result = await rotateProject(
      customer,
      "conn-1",
      "postgres://u:p@host:5432/db",
      caches,
      "main",
    );

    expect(result).toEqual({
      id: "conn-1",
      region: "eu",
    });

    // The ciphertext / kms_key_id / rotated_at land on the CHILD row,
    // not the parent — the parent `projects` row is identity only
    // post-0008.
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === projectDatabases,
    );
    expect(
      childUpdate,
      "rotation must issue UPDATE on project_databases",
    ).toBeDefined();
    const set = childUpdate?.set as
      | { encryptedDsn: Buffer; kmsKeyId: string; rotatedAt: Date }
      | undefined;
    expect(set?.encryptedDsn).toEqual(
      Buffer.from("ct:postgres://u:p@host:5432/db"),
    );
    expect(set?.kmsKeyId).toBe(`env:eu:${"postgres://u:p@host:5432/db".length}`);
    expect(set?.rotatedAt).toBeInstanceOf(Date);

    // Cache invalidation now keys per-credential (the child id), so a
    // future multi-DB rotation only invalidates the rotated credential.
    expect(caches.cache.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.cache.invalidate).toHaveBeenCalledWith("cdb-main-1", "eu");
    // PR2 of mcp_url_auth_security: ContainerRegistry keys on the parent
    // project id, not the (now-removed) mcp_token.
    expect(caches.registry.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledWith("conn-1");
  });

  it("404 path: returns null and skips both invalidations when ownership mismatches", async () => {
    handle.setParentSelectResult([]);
    const { rotateProject } = await import("../src/lib/projects.ts");
    const caches = makeCaches();

    const result = await rotateProject(
      customer,
      "conn-other-customer",
      "postgres://u:p@host:5432/db",
      caches,
      "main",
    );

    expect(result).toBeNull();
    expect(caches.cache.invalidate).not.toHaveBeenCalled();
    expect(caches.registry.invalidate).not.toHaveBeenCalled();
  });

  it("failure isolation: cache.invalidate throwing does NOT prevent registry.invalidate from running", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", region: "eu" },
    ]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { rotateProject } = await import("../src/lib/projects.ts");
    const caches = makeCaches({
      cache: {
        invalidate: vi.fn(() => {
          throw new Error("cache exploded");
        }),
      },
    });
    // Suppress the expected console.error from the rotation path.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await rotateProject(
      customer,
      "conn-1",
      "postgres://u:p@host:5432/db",
      caches,
      "main",
    );

    // Rotation reports success — DB is committed; the cache failure is
    // logged but not surfaced (caches catch up at next idle expiry).
    expect(result).toEqual({
      id: "conn-1",
      region: "eu",
    });
    expect(caches.cache.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledTimes(1);
    expect(caches.registry.invalidate).toHaveBeenCalledWith("conn-1");
    errorSpy.mockRestore();
  });
});

interface PolicyDepsSpy {
  registry: { invalidate: ReturnType<typeof vi.fn> };
  pushPolicy: ReturnType<typeof vi.fn>;
}

function makePolicyDeps(
  pushResult: unknown | (() => unknown | Promise<unknown>) = {
    delivered: true,
  },
): PolicyDepsSpy {
  return {
    registry: { invalidate: vi.fn(async () => undefined) },
    pushPolicy: vi.fn(async () => {
      if (typeof pushResult === "function") {
        return (pushResult as () => unknown)();
      }
      return pushResult;
    }),
  };
}

const goodPolicy = {
  default: "read",
  tables: { "public.users": "deny" },
} as const;

// Inert tenant_scope envelope reused across fixtures. Mirrors the
// EMPTY_TENANT_SCOPE constant exported from @midplane-cloud/db.
const inertScope = { column: null, overrides: {}, exempt: [] };

const ACTOR = "user_clerk-actor";

describe("setTableAccess", () => {
  // Shape returned by the in-txn siblings select. Mirrors the post-update
  // state, since Postgres reads see writes within the same txn.
  const mainSibling = {
    id: "cdb-main-1",
    name: "main",
    tableAccess: goodPolicy,
    tenantScope: inertScope,
  };
  // Expected pushPolicy second arg: the multi-DB body remapped from
  // siblings rows. PR-A bumps OSS to 0.4.0; the legacy single-section
  // body is rejected on every cloud-managed engine, so the helper now
  // serializes the full DatabaseEntry[] shape.
  const mainEntry = {
    name: "main",
    projectDatabaseId: "cdb-main-1",
    tableAccess: goodPolicy,
    tenantScope: inertScope,
  };

  it("happy path: writes Postgres, hot-reloads engine, does NOT invalidate", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [mainEntry]);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("idle-agent path: delivered=false short-circuits without invalidate", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: false });

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledTimes(1);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejected (400): throws EnginePolicyRejected, does NOT fall back to invalidate", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess, EnginePolicyRejected } = await import(
      "../src/lib/projects.ts"
    );
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "tables.foo: must be one of …" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setTableAccess(customer, "conn-1", goodPolicy, deps, ACTOR),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("network failure: falls back to registry.invalidate (fail-soft, like rotateProject)", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps(() => {
      throw new Error("ECONNREFUSED");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
    errorSpy.mockRestore();
  });

  it("dbName not found: returns null when the named child doesn't exist on the project", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([]); // child UPDATE matches 0 rows
    // No siblings queue entry needed — the txn short-circuits before
    // the siblings select runs.
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
      "analytics",
    );

    expect(result).toBeNull();
    // Engine push must NOT fire when the DB write didn't land.
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("explicit dbName: writes to the named child, pushes policy with same token", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-analytics-1" }]);
    handle.queueSelect([
      {
        id: "cdb-analytics-1",
        name: "analytics",
        tableAccess: goodPolicy,
        tenantScope: inertScope,
      },
    ]);
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
      "analytics",
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "analytics",
        projectDatabaseId: "cdb-analytics-1",
        tableAccess: goodPolicy,
        tenantScope: inertScope,
      },
    ]);
    // The child UPDATE's where-clause must reference the explicit dbName,
    // not "main". We can't introspect the drizzle expression directly,
    // but we can confirm the update fired against project_databases.
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === projectDatabases,
    );
    expect(childUpdate).toBeDefined();
  });

  it("multi-DB project: pushPolicy body lists every sibling so OSS doesn't drop them", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    // Edited DB ("main") plus an untouched sibling ("analytics"). OSS
    // 0.4.0 drops any DB absent from the body, so the cloud must restate
    // every DB on the project on every hot-reload.
    handle.queueSelect([
      mainSibling,
      {
        id: "cdb-analytics-1",
        name: "analytics",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: {
          column: "tenant_id",
          overrides: { orders: "org_id" },
          exempt: [],
        },
      },
    ]);
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTableAccess(
      customer,
      "conn-1",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      mainEntry,
      {
        name: "analytics",
        projectDatabaseId: "cdb-analytics-1",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: {
          column: "tenant_id",
          overrides: { orders: "org_id" },
          exempt: [],
        },
      },
    ]);
  });

  it("404 path: returns null and skips push/invalidate when ownership mismatches", async () => {
    handle.queueSelect([]); // parent ownership check returns no row
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    const result = await setTableAccess(
      customer,
      "conn-other",
      goodPolicy,
      deps,
      ACTOR,
    );

    expect(result).toBeNull();
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejects malformed policies before touching Postgres", async () => {
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    await expect(
      setTableAccess(
        customer,
        "conn-1",
        { default: "bogus", tables: {} } as unknown as Parameters<
          typeof setTableAccess
        >[2],
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid policy/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.pushPolicy).not.toHaveBeenCalled();
  });

  it("emits POLICY_CHANGED audit row stamped with the actor", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    await setTableAccess(customer, "conn-1", goodPolicy, deps, ACTOR);

    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "POLICY_CHANGED audit row must be inserted").toBeDefined();
    const row = audit?.set as
      | {
          eventType: string;
          customerId: string;
          tenantId: string;
          actorUserId: string;
          payload: {
            project_id: string;
            database_name: string;
            policy: typeof goodPolicy;
          };
        }
      | undefined;
    expect(row?.eventType).toBe("POLICY_CHANGED");
    expect(row?.customerId).toBe(customer.id);
    expect(row?.tenantId).toBe("conn-1");
    expect(row?.actorUserId).toBe(ACTOR);
    expect(row?.payload.project_id).toBe("conn-1");
    expect(row?.payload.database_name).toBe("main");

    // RLS bind: the audit insert must run inside a txn that first
    // executed SET LOCAL app.customer_id. Without that, RLS (once a
    // non-bypass app role is in use) rejects the insert and we silently
    // lose the audit row.
    const setLocal = handle.calls.find(
      (c) => c.op === "execute" && String(c.set).includes("SET LOCAL app.customer_id"),
    );
    expect(setLocal, "audit insert must bind app.customer_id via SET LOCAL").toBeDefined();
  });

  it("stamps database column with dbName for non-main DBs (preserves /audit per-DB filter)", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-analytics-1" }]);
    handle.queueSelect([
      {
        id: "cdb-analytics-1",
        name: "analytics",
        tableAccess: goodPolicy,
        tenantScope: inertScope,
      },
    ]);
    const { setTableAccess } = await import("../src/lib/projects.ts");
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    await setTableAccess(customer, "conn-1", goodPolicy, deps, ACTOR, "analytics");

    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    const row = audit?.set as { database: string } | undefined;
    expect(row?.database, "audit.database must equal dbName, not the 'main' column default").toBe(
      "analytics",
    );
  });

  it("does NOT emit POLICY_CHANGED when engine rejects the policy", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTableAccess, EnginePolicyRejected } = await import(
      "../src/lib/projects.ts"
    );
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "tables.foo: must be one of …" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setTableAccess(customer, "conn-1", goodPolicy, deps, ACTOR),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "audit row must NOT be written for rejected policies").toBeUndefined();
    errorSpy.mockRestore();
  });
});

describe("setTenantScope", () => {
  // Sibling-select returns the post-update row, so the new config shape
  // (column + overrides + exempt) is what the engine receives.
  const strictScope = {
    column: "tenant_id",
    overrides: { orders: "org_id" },
    exempt: ["audit_log"],
  };
  const mainSibling = {
    id: "cdb-main-1",
    name: "main",
    tableAccess: { default: "read", tables: {} },
    tenantScope: strictScope,
  };

  it("happy path: writes Postgres, hot-reloads engine with the strict-mode body", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTenantScope(customer, "conn-1", strictScope, deps, ACTOR);

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        projectDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: strictScope,
      },
    ]);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("multi-DB project: restates every sibling so OSS doesn't drop the untouched one", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([
      mainSibling,
      {
        id: "cdb-analytics-1",
        name: "analytics",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: inertScope,
      },
    ]);
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: true });

    await setTenantScope(customer, "conn-1", strictScope, deps, ACTOR);

    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        projectDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: strictScope,
      },
      {
        name: "analytics",
        projectDatabaseId: "cdb-analytics-1",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: inertScope,
      },
    ]);
  });

  it("inert envelope: persists EMPTY_TENANT_SCOPE (= tenant_scope disabled on this DB)", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([
      {
        id: "cdb-main-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
        tenantScope: inertScope,
      },
    ]);
    const { projectDatabases } = await import("@midplane-cloud/db");
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: true });

    await setTenantScope(customer, "conn-1", inertScope, deps, ACTOR);

    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === projectDatabases,
    );
    expect(childUpdate).toBeDefined();
    const set = childUpdate?.set as
      | { tenantScope: typeof inertScope }
      | undefined;
    expect(set?.tenantScope).toEqual(inertScope);
  });

  it("column=null + overrides-only envelope round-trips through the engine", async () => {
    // The 0012 backfill wraps pre-0.5.0 flat maps into {column:null,
    // overrides:<old>, exempt:[]} so existing customers keep working
    // without a forced default-column decision.
    const overridesOnly = {
      column: null,
      overrides: { orders: "tenant_id" },
      exempt: [],
    };
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([
      {
        id: "cdb-main-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
        tenantScope: overridesOnly,
      },
    ]);
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: true });

    await setTenantScope(customer, "conn-1", overridesOnly, deps, ACTOR);

    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        projectDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: overridesOnly,
      },
    ]);
  });

  it("rejected (400): throws EnginePolicyRejected and does NOT fall back to invalidate", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope, EnginePolicyRejected } = await import(
      "../src/lib/projects.ts"
    );
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "tenant_scope.overrides.orders: …" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setTenantScope(customer, "conn-1", strictScope, deps, ACTOR),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("network failure: falls back to registry.invalidate (fail-soft)", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps(() => {
      throw new Error("ECONNREFUSED");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await setTenantScope(customer, "conn-1", strictScope, deps, ACTOR);
    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
    errorSpy.mockRestore();
  });

  it("dbName not found: returns null when the named child doesn't exist on the project", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([]); // 0 rows matched the dbName
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    const result = await setTenantScope(
      customer,
      "conn-1",
      strictScope,
      deps,
      ACTOR,
      "ghost-db",
    );

    expect(result).toBeNull();
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("404 path: returns null and skips push/invalidate when ownership mismatches", async () => {
    handle.queueSelect([]); // parent ownership check returns no row
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    const result = await setTenantScope(
      customer,
      "conn-other",
      strictScope,
      deps,
      ACTOR,
    );

    expect(result).toBeNull();
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejects non-identifier column before touching Postgres", async () => {
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: "bad name", overrides: {}, exempt: [] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.pushPolicy).not.toHaveBeenCalled();
  });

  it("accepts schema-qualified table names in overrides + exempt (autocomplete returns public.users)", async () => {
    // The shared TableNameInput fills the field from
    // information_schema as `schema.table`. tenant_scope keys must
    // accept that shape — otherwise a save with an autocompleted value
    // would fail before the engine even sees it.
    const schemaScope = {
      column: "tenant_id",
      overrides: { "public.users": "customer_id" },
      exempt: ["public.regions"],
    };
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([
      {
        id: "cdb-main-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
        tenantScope: schemaScope,
      },
    ]);
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setTenantScope(customer, "conn-1", schemaScope, deps, ACTOR);

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        projectDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: schemaScope,
      },
    ]);
  });

  it("rejects schema-qualified default column (columns are single identifiers, only tables can be schema-qualified)", async () => {
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();
    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: "public.tenant_id", overrides: {}, exempt: [] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
    expect(handle.calls).toHaveLength(0);
  });

  it("rejects non-identifier override keys / values", async () => {
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: null, overrides: { "bad name": "tenant_id" }, exempt: [] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: null, overrides: { orders: "tenant id" }, exempt: [] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
    expect(handle.calls).toHaveLength(0);
  });

  it("rejects non-identifier exempt entries", async () => {
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    await expect(
      setTenantScope(
        customer,
        "conn-1",
        { column: "tenant_id", overrides: {}, exempt: ["bad name"] },
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid tenant_scope/);
  });

  it("emits TENANT_SCOPE_CHANGED audit row stamped with the actor", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope } = await import("../src/lib/projects.ts");
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    await setTenantScope(customer, "conn-1", strictScope, deps, ACTOR);

    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "TENANT_SCOPE_CHANGED audit row must be inserted").toBeDefined();
    const row = audit?.set as
      | {
          eventType: string;
          customerId: string;
          tenantId: string;
          actorUserId: string;
          payload: {
            project_id: string;
            database_name: string;
            config: typeof strictScope;
          };
        }
      | undefined;
    expect(row?.eventType).toBe("TENANT_SCOPE_CHANGED");
    expect(row?.customerId).toBe(customer.id);
    expect(row?.tenantId).toBe("conn-1");
    expect(row?.actorUserId).toBe(ACTOR);
    expect(row?.payload.project_id).toBe("conn-1");
    expect(row?.payload.database_name).toBe("main");
    expect(row?.payload.config).toEqual(strictScope);

    // RLS bind — see the matching assertion in the POLICY_CHANGED test.
    const setLocal = handle.calls.find(
      (c) => c.op === "execute" && String(c.set).includes("SET LOCAL app.customer_id"),
    );
    expect(setLocal, "audit insert must bind app.customer_id via SET LOCAL").toBeDefined();
  });

  it("does NOT emit TENANT_SCOPE_CHANGED when engine rejects the config", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setTenantScope, EnginePolicyRejected } = await import(
      "../src/lib/projects.ts"
    );
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "tenant_scope.column: must match identifier regex" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setTenantScope(customer, "conn-1", strictScope, deps, ACTOR),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "audit row must NOT be written for rejected configs").toBeUndefined();
    errorSpy.mockRestore();
  });
});

describe("setGuardrails", () => {
  const optOut = { block_unqualified_dml: true, block_ddl: false };
  // Post-update sibling row — post-0021 rows always carry guardrails.
  const mainSibling = {
    id: "cdb-main-1",
    name: "main",
    tableAccess: { default: "read", tables: {} },
    tenantScope: inertScope,
    guardrails: optOut,
  };

  it("happy path: writes Postgres, hot-reloads engine with guardrails in the multi-DB body", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { projectDatabases } = await import("@midplane-cloud/db");
    const { setGuardrails } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: true });

    const result = await setGuardrails(customer, "conn-1", optOut, deps, ACTOR);

    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        projectDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: inertScope,
        guardrails: optOut,
      },
    ]);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();

    // The opt-out must land on the child row exactly as validated — an
    // omitted `false` would silently revert to the engine's default-ON.
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === projectDatabases,
    );
    const set = childUpdate?.set as { guardrails: typeof optOut } | undefined;
    expect(set?.guardrails).toEqual(optOut);
  });

  it("multi-DB project: restates every sibling's guardrails so OSS doesn't drop them", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([
      mainSibling,
      {
        id: "cdb-analytics-1",
        name: "analytics",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: inertScope,
        guardrails: { block_unqualified_dml: true, block_ddl: true },
      },
    ]);
    const { setGuardrails } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps({ delivered: true });

    await setGuardrails(customer, "conn-1", optOut, deps, ACTOR);

    expect(deps.pushPolicy).toHaveBeenCalledWith("conn-1", [
      {
        name: "main",
        projectDatabaseId: "cdb-main-1",
        tableAccess: { default: "read", tables: {} },
        tenantScope: inertScope,
        guardrails: optOut,
      },
      {
        name: "analytics",
        projectDatabaseId: "cdb-analytics-1",
        tableAccess: { default: "deny", tables: {} },
        tenantScope: inertScope,
        guardrails: { block_unqualified_dml: true, block_ddl: true },
      },
    ]);
  });

  it("rejected (400): throws EnginePolicyRejected and does NOT fall back to invalidate", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setGuardrails, EnginePolicyRejected } = await import(
      "../src/lib/projects.ts"
    );
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({
      rejected: { status: 400, body: "guardrails.block_ddl: must be boolean" },
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      setGuardrails(customer, "conn-1", optOut, deps, ACTOR),
    ).rejects.toBeInstanceOf(EnginePolicyRejected);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
    // Same convention the sibling setters pin: recording "guardrails
    // changed" for a config the engine refused would be a lie.
    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "audit row must NOT be written for rejected configs").toBeUndefined();
    errorSpy.mockRestore();
  });

  it("network failure: falls back to registry.invalidate (fail-soft)", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setGuardrails } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps(() => {
      throw new Error("ECONNREFUSED");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await setGuardrails(customer, "conn-1", optOut, deps, ACTOR);
    expect(result).toMatchObject({ id: "conn-1" });
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
    errorSpy.mockRestore();
  });

  it("dbName not found / foreign owner: returns null and skips push", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([]); // 0 rows matched the dbName
    const { setGuardrails } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    const result = await setGuardrails(
      customer,
      "conn-1",
      optOut,
      deps,
      ACTOR,
      "ghost-db",
    );

    expect(result).toBeNull();
    expect(deps.pushPolicy).not.toHaveBeenCalled();
  });

  it("404 path: returns null and skips push/invalidate when ownership mismatches", async () => {
    handle.queueSelect([]); // parent ownership check returns no row
    const { setGuardrails } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    const result = await setGuardrails(
      customer,
      "conn-other",
      optOut,
      deps,
      ACTOR,
    );

    expect(result).toBeNull();
    expect(deps.pushPolicy).not.toHaveBeenCalled();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejects non-boolean flags before touching Postgres", async () => {
    const { setGuardrails } = await import("../src/lib/projects.ts");
    const deps = makePolicyDeps();

    await expect(
      setGuardrails(
        customer,
        "conn-1",
        { block_unqualified_dml: "yes", block_ddl: true } as never,
        deps,
        ACTOR,
      ),
    ).rejects.toThrow(/invalid guardrails/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.pushPolicy).not.toHaveBeenCalled();
  });

  it("emits GUARDRAILS_CHANGED audit row stamped with the actor and the resulting flags", async () => {
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    handle.queueSelect([mainSibling]);
    const { setGuardrails } = await import("../src/lib/projects.ts");
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const deps = makePolicyDeps({ delivered: true });

    await setGuardrails(customer, "conn-1", optOut, deps, ACTOR);

    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "GUARDRAILS_CHANGED audit row must be inserted").toBeDefined();
    const row = audit?.set as
      | {
          eventType: string;
          tenantId: string;
          actorUserId: string;
          payload: {
            project_id: string;
            database_name: string;
            guardrails: typeof optOut;
          };
        }
      | undefined;
    expect(row?.eventType).toBe("GUARDRAILS_CHANGED");
    expect(row?.tenantId).toBe("conn-1");
    expect(row?.actorUserId).toBe(ACTOR);
    expect(row?.payload.guardrails).toEqual(optOut);
  });
});

describe("setIgnoredColumns", () => {
  const dismissals = { "public.users": ["display_name", "ip_version"] };

  it("happy path: writes ignored_columns to the named child and returns the project id", async () => {
    handle.queueSelect([{ id: "conn-1" }]); // parent ownership check
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { projectDatabases } = await import("@midplane-cloud/db");
    const { setIgnoredColumns } = await import("../src/lib/projects.ts");

    const result = await setIgnoredColumns(customer, "conn-1", dismissals);

    expect(result).toMatchObject({ id: "conn-1" });
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === projectDatabases,
    );
    const set = childUpdate?.set as { ignoredColumns: typeof dismissals } | undefined;
    expect(set?.ignoredColumns).toEqual(dismissals);
  });

  it("is scan-view state, not policy: writes NO audit row (and there's no engine push to make)", async () => {
    handle.queueSelect([{ id: "conn-1" }]);
    handle.setChildUpdateResult([{ id: "cdb-main-1" }]);
    const { auditEventsIndex } = await import("@midplane-cloud/db");
    const { setIgnoredColumns } = await import("../src/lib/projects.ts");

    await setIgnoredColumns(customer, "conn-1", dismissals);

    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit, "a dismissal is not a policy change — no audit row").toBeUndefined();
  });

  it("404 path: returns null when ownership mismatches (parent check empty)", async () => {
    handle.queueSelect([]); // no owned project
    const { setIgnoredColumns } = await import("../src/lib/projects.ts");

    const result = await setIgnoredColumns(customer, "conn-other", dismissals);
    expect(result).toBeNull();
  });

  it("dbName not found: returns null when no child row matched", async () => {
    handle.queueSelect([{ id: "conn-1" }]);
    handle.setChildUpdateResult([]); // 0 rows matched the dbName
    const { setIgnoredColumns } = await import("../src/lib/projects.ts");

    const result = await setIgnoredColumns(customer, "conn-1", dismissals, "ghost-db");
    expect(result).toBeNull();
  });

  it("rejects a malformed identifier before touching Postgres", async () => {
    const { setIgnoredColumns } = await import("../src/lib/projects.ts");

    await expect(
      setIgnoredColumns(customer, "conn-1", { "public.users": ["ema il"] } as never),
    ).rejects.toThrow(/invalid ignored_columns/);
    expect(handle.calls).toHaveLength(0);
  });
});

describe("maskConfigAddsMasking", () => {
  const redactEmail: ColumnMasksConfig = { "public.users": { email: "full-redact" } };

  it("false for an identical config (no-op save)", async () => {
    const { maskConfigAddsMasking } = await import("../src/lib/projects.ts");
    expect(maskConfigAddsMasking(redactEmail, redactEmail)).toBe(false);
  });

  it("true when a new masked column is added", async () => {
    const { maskConfigAddsMasking } = await import("../src/lib/projects.ts");
    expect(maskConfigAddsMasking({}, redactEmail)).toBe(true);
  });

  it("true when an existing column's rule changes", async () => {
    const { maskConfigAddsMasking } = await import("../src/lib/projects.ts");
    const before: ColumnMasksConfig = { "public.users": { ssn: "full-redact" } };
    const after: ColumnMasksConfig = { "public.users": { ssn: "null-out" } };
    expect(maskConfigAddsMasking(before, after)).toBe(true);
  });

  it("false for a pure removal — the recovery path stays open", async () => {
    const { maskConfigAddsMasking } = await import("../src/lib/projects.ts");
    const before: ColumnMasksConfig = {
      "public.users": { ssn: "full-redact", email: "full-redact" },
    };
    const after: ColumnMasksConfig = { "public.users": { email: "full-redact" } };
    expect(maskConfigAddsMasking(before, after)).toBe(false);
  });

  it("false when clearing the last masked column (→ empty)", async () => {
    const { maskConfigAddsMasking } = await import("../src/lib/projects.ts");
    expect(maskConfigAddsMasking(redactEmail, {})).toBe(false);
  });
});

describe("rotateProject with explicit dbName", () => {
  it("rotates the named child, not main, when dbName is passed", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", region: "eu" },
    ]);
    handle.setChildUpdateResult([{ id: "cdb-analytics-1" }]);
    const { projectDatabases } = await import("@midplane-cloud/db");
    const { rotateProject } = await import("../src/lib/projects.ts");
    const caches = makeCaches();

    const result = await rotateProject(
      customer,
      "conn-1",
      "postgres://u:p@host:5432/analytics",
      caches,
      "analytics",
    );

    expect(result).toEqual({
      id: "conn-1",
      region: "eu",
    });
    // Cache invalidation keys on the rotated child id, so a sibling DB's
    // DecryptCache entry stays warm. The container is invalidated by
    // project id (PR2 of mcp_url_auth_security — was mcpToken).
    expect(caches.cache.invalidate).toHaveBeenCalledWith(
      "cdb-analytics-1",
      "eu",
    );
    expect(caches.registry.invalidate).toHaveBeenCalledWith("conn-1");
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === projectDatabases,
    );
    expect(childUpdate).toBeDefined();
  });

  it("returns null and skips invalidations when the named child does not exist", async () => {
    handle.setParentSelectResult([
      { id: "conn-1", region: "eu" },
    ]);
    handle.setChildUpdateResult([]); // 0 rows matched the dbName
    const { rotateProject } = await import("../src/lib/projects.ts");
    const caches = makeCaches();

    const result = await rotateProject(
      customer,
      "conn-1",
      "postgres://u:p@host:5432/db",
      caches,
      "ghost-db",
    );

    expect(result).toBeNull();
    expect(caches.cache.invalidate).not.toHaveBeenCalled();
    expect(caches.registry.invalidate).not.toHaveBeenCalled();
  });
});

describe("isValidDatabaseName", () => {
  it("accepts the OSS DB_NAME_RE shape", async () => {
    const { isValidDatabaseName } = await import("../src/lib/projects.ts");
    expect(isValidDatabaseName("main")).toBe(true);
    expect(isValidDatabaseName("a")).toBe(true);
    expect(isValidDatabaseName("analytics")).toBe(true);
    expect(isValidDatabaseName("db_with-mix3d")).toBe(true);
    expect(isValidDatabaseName("a".repeat(32))).toBe(true);
  });

  it("rejects invalid shapes (caps, leading digit, too long, empty, non-string)", async () => {
    const { isValidDatabaseName } = await import("../src/lib/projects.ts");
    expect(isValidDatabaseName("")).toBe(false);
    expect(isValidDatabaseName("Main")).toBe(false);
    expect(isValidDatabaseName("1main")).toBe(false);
    expect(isValidDatabaseName("_leading")).toBe(false);
    expect(isValidDatabaseName("with space")).toBe(false);
    expect(isValidDatabaseName("a".repeat(33))).toBe(false);
    expect(isValidDatabaseName(null)).toBe(false);
    expect(isValidDatabaseName(undefined)).toBe(false);
  });
});

describe("slugifyDatabaseName", () => {
  it("coerces arbitrary input into a valid alias", async () => {
    const { slugifyDatabaseName, isValidDatabaseName } = await import(
      "../src/lib/project-name.ts"
    );
    expect(slugifyDatabaseName("Mask E2E DB")).toBe("mask-e2e-db");
    expect(slugifyDatabaseName("Analytics")).toBe("analytics");
    expect(slugifyDatabaseName("my.db/prod")).toBe("my-db-prod");
    expect(slugifyDatabaseName("  spaced  name  ")).toBe("spaced-name");
    // Output is always a valid alias (or empty).
    for (const s of ["Mask E2E DB", "my.db/prod", "UPPER"]) {
      const slug = slugifyDatabaseName(s);
      expect(slug === "" || isValidDatabaseName(slug)).toBe(true);
    }
  });

  it("strips leading non-letters and trailing separators", async () => {
    const { slugifyDatabaseName } = await import("../src/lib/project-name.ts");
    expect(slugifyDatabaseName("123abc")).toBe("abc");
    expect(slugifyDatabaseName("__db__")).toBe("db");
    expect(slugifyDatabaseName("name-")).toBe("name");
  });

  it("returns empty when nothing valid survives (caller falls back to DSN name)", async () => {
    const { slugifyDatabaseName } = await import("../src/lib/project-name.ts");
    expect(slugifyDatabaseName("123")).toBe("");
    expect(slugifyDatabaseName("   ")).toBe("");
    expect(slugifyDatabaseName("!!!")).toBe("");
  });

  it("clamps to the 32-char engine grammar max", async () => {
    const { slugifyDatabaseName } = await import("../src/lib/project-name.ts");
    expect(slugifyDatabaseName("a".repeat(40)).length).toBe(32);
  });
});

interface MutationDepsSpy {
  registry: { invalidate: ReturnType<typeof vi.fn> };
}

function makeMutationDeps(): MutationDepsSpy {
  return { registry: { invalidate: vi.fn(async () => undefined) } };
}

describe("addDatabase", () => {
  it("happy path: encrypts DSN, inserts child row, invalidates registry", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]); // parent ownership
    handle.queueSelect([{ count: 1 }]); // sibling count → 1 < 10 ✓
    handle.queueSelect([]); // sibling-collision check returns empty
    const { addDatabase } = await import("../src/lib/projects.ts");
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await addDatabase(
      customer,
      "conn-1",
      "analytics",
      "postgres://u:p@host:5432/analytics",
      "read",
      deps,
    );

    expect(result).not.toBeNull();
    // PR2 of mcp_url_auth_security: addDatabase returns { id, projectId }.
    // `id` is the freshly-minted child id (a ULID); `projectId` is the
    // parent project id used by the registry invalidation below.
    expect(result?.projectId).toBe("conn-1");
    expect(typeof result?.id).toBe("string");
    expect(result?.id).not.toBe("conn-1"); // child id is fresh

    const insert = handle.calls.find(
      (c) => c.op === "insert" && c.table === projectDatabases,
    );
    expect(insert, "must INSERT into project_databases").toBeDefined();
    const set = insert?.set as
      | { name: string; encryptedDsn: Buffer; tableAccess: { default: string } }
      | undefined;
    expect(set?.name).toBe("analytics");
    expect(set?.encryptedDsn).toEqual(
      Buffer.from("ct:postgres://u:p@host:5432/analytics"),
    );
    expect(set?.tableAccess.default).toBe("read");
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
  });

  it("throws DatabaseLimitError at the fixed per-project ceiling, without inserting", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]); // parent ownership + lock
    handle.queueSelect([{ count: 10 }]); // sibling count → 10 >= 10 (fixed ceiling)
    const { addDatabase } = await import("../src/lib/projects.ts");
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const err = await addDatabase(
      customer,
      "conn-1",
      "analytics",
      "postgres://u:p@host:5432/db",
      "read",
      deps,
    ).catch((e) => e);

    // Structural cap (plan-independent) → DatabaseLimitError, NOT PlanLimitError.
    expect(err).toBeInstanceOf(DatabaseLimitError);
    expect(err.limit).toBe(10);
    const insert = handle.calls.find(
      (c) => c.op === "insert" && c.table === projectDatabases,
    );
    expect(insert, "no insert at the ceiling").toBeUndefined();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("skips the sibling count entirely in self-host (uncapped — Infinity)", async () => {
    // Pins the Number.isFinite guard: self-host resolves the ceiling to
    // Infinity, so an add issues exactly one project_databases select (the
    // collision check) — the cap-count select never fires.
    const prev = process.env.MIDPLANE_SELF_HOST;
    process.env.MIDPLANE_SELF_HOST = "1";
    try {
      handle.setProjectsReturning([{ id: "conn-1" }]);
      handle.queueSelect([{ id: "conn-1", region: "eu" }]); // parent lock
      handle.queueSelect([]); // collision check
      const { addDatabase } = await import("../src/lib/projects.ts");
      const { projectDatabases } = await import("@midplane-cloud/db");
      const deps = makeMutationDeps();

      await addDatabase(
        customer,
        "conn-1",
        "analytics",
        "postgres://u:p@host:5432/db",
        "read",
        deps,
      );

      const dbSelects = handle.calls.filter(
        (c) => c.op === "select" && c.table === projectDatabases,
      );
      expect(dbSelects, "only the collision check — no cap count").toHaveLength(
        1,
      );
    } finally {
      if (prev === undefined) delete process.env.MIDPLANE_SELF_HOST;
      else process.env.MIDPLANE_SELF_HOST = prev;
    }
  });

  it("counts siblings on the finite (cloud) ceiling and passes under it", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]); // parent ownership + lock
    handle.queueSelect([{ count: 1 }]); // sibling count → 1 < 10 ✓
    handle.queueSelect([]); // sibling-collision check returns empty
    const { addDatabase } = await import("../src/lib/projects.ts");
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await addDatabase(
      customer,
      "conn-1",
      "analytics",
      "postgres://u:p@host:5432/db",
      "read",
      deps,
    );

    expect(result?.projectId).toBe("conn-1");
    const insert = handle.calls.find(
      (c) => c.op === "insert" && c.table === projectDatabases,
    );
    expect(insert, "insert proceeds under the ceiling").toBeDefined();
  });

  it("name collision: throws DatabaseNameTaken without inserting or invalidating", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ count: 1 }]); // sibling count → 1 < 10 ✓
    handle.queueSelect([{ id: "cdb-existing" }]); // sibling already owns the name
    const { addDatabase, DatabaseNameTaken } = await import(
      "../src/lib/projects.ts"
    );
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    await expect(
      addDatabase(
        customer,
        "conn-1",
        "analytics",
        "postgres://u:p@host:5432/db",
        "read",
        deps,
      ),
    ).rejects.toBeInstanceOf(DatabaseNameTaken);

    const insert = handle.calls.find(
      (c) => c.op === "insert" && c.table === projectDatabases,
    );
    expect(insert, "no insert when name is taken").toBeUndefined();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("404 path: returns null when ownership mismatches", async () => {
    handle.setProjectsReturning([]); // parent select returns empty
    const { addDatabase } = await import("../src/lib/projects.ts");
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await addDatabase(
      customer,
      "conn-other",
      "analytics",
      "postgres://u:p@host:5432/db",
      "read",
      deps,
    );

    expect(result).toBeNull();
    const insert = handle.calls.find(
      (c) => c.op === "insert" && c.table === projectDatabases,
    );
    expect(insert).toBeUndefined();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejects invalid dbName before touching KMS / Postgres", async () => {
    const { addDatabase } = await import("../src/lib/projects.ts");
    const deps = makeMutationDeps();

    await expect(
      addDatabase(
        customer,
        "conn-1",
        "Bad Name", // caps + space
        "postgres://u:p@host:5432/db",
        "read",
        deps,
      ),
    ).rejects.toThrow(/invalid database name/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("translates a Postgres unique-violation at insert into DatabaseNameTaken", async () => {
    // Belt-and-suspenders: the FOR UPDATE lock plus the in-txn
    // pre-check should make this unreachable, but the outer catch
    // must still translate a raw 23505 into the typed error so the
    // dashboard action keeps working under any future race.
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ count: 1 }]); // sibling count → 1 < 10 ✓
    handle.queueSelect([]); // pre-check: no collision visible yet
    handle.failNextInsert({
      code: "23505",
      constraint_name: "project_databases_project_name_uq",
      message: "duplicate key value violates unique constraint",
    });
    const { addDatabase, DatabaseNameTaken } = await import(
      "../src/lib/projects.ts"
    );
    const deps = makeMutationDeps();

    await expect(
      addDatabase(
        customer,
        "conn-1",
        "analytics",
        "postgres://u:p@host:5432/db",
        "read",
        deps,
      ),
    ).rejects.toBeInstanceOf(DatabaseNameTaken);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rethrows non-unique driver errors as-is", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ count: 1 }]); // sibling count → 1 < 10 ✓
    handle.queueSelect([]);
    const realFailure = new Error("project terminated unexpectedly");
    handle.failNextInsert(realFailure);
    const { addDatabase } = await import("../src/lib/projects.ts");
    const deps = makeMutationDeps();

    await expect(
      addDatabase(
        customer,
        "conn-1",
        "analytics",
        "postgres://u:p@host:5432/db",
        "read",
        deps,
      ),
    ).rejects.toBe(realFailure);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });
});

describe("removeDatabase", () => {
  it("happy path: deletes the named child, invalidates registry", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]); // ownership
    handle.queueSelect([{ id: "cdb-main" }, { id: "cdb-analytics" }]); // 2 siblings
    handle.setChildDeleteResult([{ id: "cdb-analytics" }]);
    const { removeDatabase } = await import("../src/lib/projects.ts");
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await removeDatabase(customer, "conn-1", "analytics", deps);

    expect(result).toMatchObject({ id: "conn-1" });
    const childDelete = handle.calls.find(
      (c) => c.op === "delete" && c.table === projectDatabases,
    );
    expect(childDelete).toBeDefined();
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
  });

  it("blocks the last database: throws LastDatabaseProtected without deleting", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ id: "cdb-main" }]); // only 1 sibling — last DB
    const { removeDatabase, LastDatabaseProtected } = await import(
      "../src/lib/projects.ts"
    );
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    await expect(
      removeDatabase(customer, "conn-1", "main", deps),
    ).rejects.toBeInstanceOf(LastDatabaseProtected);

    const childDelete = handle.calls.find(
      (c) => c.op === "delete" && c.table === projectDatabases,
    );
    expect(childDelete, "no delete when blocked by last-DB rule").toBeUndefined();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("404 path: returns null when ownership mismatches", async () => {
    handle.setProjectsReturning([]);
    const { removeDatabase } = await import("../src/lib/projects.ts");
    const deps = makeMutationDeps();

    const result = await removeDatabase(customer, "conn-other", "main", deps);

    expect(result).toBeNull();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("dbName not on project: returns null after attempting delete", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ id: "cdb-main" }, { id: "cdb-analytics" }]); // 2 siblings → not blocked
    handle.setChildDeleteResult([]); // delete matched 0 rows
    const { removeDatabase } = await import("../src/lib/projects.ts");
    const deps = makeMutationDeps();

    const result = await removeDatabase(customer, "conn-1", "ghost-db", deps);

    expect(result).toBeNull();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });
});

describe("renameDatabase", () => {
  it("happy path: updates name, invalidates registry (forces container restart)", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([]); // no sibling collision
    handle.setChildUpdateResult([{ id: "cdb-analytics-1" }]);
    const { renameDatabase } = await import("../src/lib/projects.ts");
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await renameDatabase(
      customer,
      "conn-1",
      "analytics",
      "warehouse",
      deps,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === projectDatabases,
    );
    expect(childUpdate).toBeDefined();
    const set = childUpdate?.set as { name: string } | undefined;
    expect(set?.name).toBe("warehouse");
    expect(deps.registry.invalidate).toHaveBeenCalledWith("conn-1");
  });

  it("name collision: throws DatabaseNameTaken without updating or invalidating", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([{ id: "cdb-other" }]); // sibling already owns "warehouse"
    const { renameDatabase, DatabaseNameTaken } = await import(
      "../src/lib/projects.ts"
    );
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    await expect(
      renameDatabase(customer, "conn-1", "analytics", "warehouse", deps),
    ).rejects.toBeInstanceOf(DatabaseNameTaken);

    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === projectDatabases,
    );
    expect(childUpdate).toBeUndefined();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("no-op rename (oldName === newName): short-circuits without container restart", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    const { renameDatabase } = await import("../src/lib/projects.ts");
    const { projectDatabases } = await import("@midplane-cloud/db");
    const deps = makeMutationDeps();

    const result = await renameDatabase(
      customer,
      "conn-1",
      "main",
      "main",
      deps,
    );

    expect(result).toMatchObject({ id: "conn-1" });
    // No update on project_databases — the rename is a no-op.
    const childUpdate = handle.calls.find(
      (c) => c.op === "update" && c.table === projectDatabases,
    );
    expect(childUpdate).toBeUndefined();
    // No restart needed for a no-op.
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("404 path: returns null when ownership mismatches", async () => {
    handle.setProjectsReturning([]);
    const { renameDatabase } = await import("../src/lib/projects.ts");
    const deps = makeMutationDeps();

    const result = await renameDatabase(
      customer,
      "conn-other",
      "main",
      "warehouse",
      deps,
    );

    expect(result).toBeNull();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("rejects invalid newName before touching Postgres", async () => {
    const { renameDatabase } = await import("../src/lib/projects.ts");
    const deps = makeMutationDeps();

    await expect(
      renameDatabase(customer, "conn-1", "main", "Bad Name", deps),
    ).rejects.toThrow(/invalid database name/);
    expect(handle.calls).toHaveLength(0);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("source dbName missing: returns null, no invalidate", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([]); // no sibling collision on newName
    handle.setChildUpdateResult([]); // update matched 0 rows
    const { renameDatabase } = await import("../src/lib/projects.ts");
    const deps = makeMutationDeps();

    const result = await renameDatabase(
      customer,
      "conn-1",
      "ghost",
      "warehouse",
      deps,
    );

    expect(result).toBeNull();
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });

  it("translates a Postgres unique-violation at update into DatabaseNameTaken", async () => {
    handle.setProjectsReturning([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "conn-1", region: "eu" }]);
    handle.queueSelect([]); // pre-check passes
    handle.failNextUpdate({
      code: "23505",
      constraint_name: "project_databases_project_name_uq",
      message: "duplicate key value violates unique constraint",
    });
    const { renameDatabase, DatabaseNameTaken } = await import(
      "../src/lib/projects.ts"
    );
    const deps = makeMutationDeps();

    await expect(
      renameDatabase(customer, "conn-1", "analytics", "warehouse", deps),
    ).rejects.toBeInstanceOf(DatabaseNameTaken);
    expect(deps.registry.invalidate).not.toHaveBeenCalled();
  });
});

describe("getProjectWithDatabase", () => {
  it("returns parent + named child when both exist", async () => {
    handle.queueSelect([
      { id: "conn-1", customerId: customer.id, region: "eu" },
    ]);
    handle.queueSelect([
      { id: "cdb-analytics-1", projectId: "conn-1", name: "analytics" },
    ]);
    const { getProjectWithDatabase } = await import(
      "../src/lib/projects.ts"
    );

    const result = await getProjectWithDatabase(
      customer,
      "conn-1",
      "analytics",
    );

    expect(result).not.toBeNull();
    expect(result?.project.id).toBe("conn-1");
    expect(result?.database.name).toBe("analytics");
  });

  it("returns null when parent missing", async () => {
    handle.queueSelect([]);
    const { getProjectWithDatabase } = await import(
      "../src/lib/projects.ts"
    );

    const result = await getProjectWithDatabase(customer, "conn-1", "main");
    expect(result).toBeNull();
  });

  it("returns null when child missing", async () => {
    handle.queueSelect([
      { id: "conn-1", customerId: customer.id, region: "eu" },
    ]);
    handle.queueSelect([]);
    const { getProjectWithDatabase } = await import(
      "../src/lib/projects.ts"
    );

    const result = await getProjectWithDatabase(customer, "conn-1", "ghost");
    expect(result).toBeNull();
  });
});

describe("getProjectWithFirstDatabase", () => {
  it("resolves the project's first database by name — NOT a fixed 'main'", async () => {
    // Regression: createProject now names the first DB from the DSN, so a
    // freshly created project has no "main". The success page + JSON rotate
    // route resolve the first child by name order instead of pinning "main".
    handle.queueSelect([
      { id: "conn-1", customerId: customer.id, region: "eu" },
    ]);
    handle.queueSelect([
      { id: "cdb-analytics-1", projectId: "conn-1", name: "analytics" },
    ]);
    const { getProjectWithFirstDatabase } = await import(
      "../src/lib/projects.ts"
    );

    const result = await getProjectWithFirstDatabase(customer, "conn-1");

    expect(result).not.toBeNull();
    expect(result?.project.id).toBe("conn-1");
    expect(result?.database.name).toBe("analytics");
  });

  it("returns null when the project is unknown / owned by another customer", async () => {
    handle.queueSelect([]);
    const { getProjectWithFirstDatabase } = await import(
      "../src/lib/projects.ts"
    );

    const result = await getProjectWithFirstDatabase(customer, "conn-1");
    expect(result).toBeNull();
  });

  it("returns null when the project has no database", async () => {
    handle.queueSelect([
      { id: "conn-1", customerId: customer.id, region: "eu" },
    ]);
    handle.queueSelect([]);
    const { getProjectWithFirstDatabase } = await import(
      "../src/lib/projects.ts"
    );

    const result = await getProjectWithFirstDatabase(customer, "conn-1");
    expect(result).toBeNull();
  });
});

// One grouped select (projects LEFT JOIN project_databases, count per row)
// → the switcher rows. The fake ignores the join/group/order clauses, so we
// exercise the mapping layer: label fallback + the resolveServing (Axis 1,
// serving readiness) contract the rail dropdown's headline dots depend on —
// never audit-drain health (see lib/freshness.ts's two-axis note).
describe("listProjectSwitcherRows", () => {
  it("maps name → label with the id-prefix fallback, and resolves ready", async () => {
    handle.queueSelect([
      {
        id: "01HSWITCHNAMEDXXXXXXXXXXXX",
        name: "prod",
        pausedAt: null,
        databaseCount: 2,
      },
      {
        id: "01HSWITCHUNNAMEDXXXXXXXXXX",
        name: null, // never named → stable 12-char id prefix (projectLabel parity)
        pausedAt: null,
        databaseCount: 1,
      },
    ]);
    const { listProjectSwitcherRows } = await import("../src/lib/projects.ts");

    const rows = await listProjectSwitcherRows(customer);

    expect(rows).toEqual([
      { id: "01HSWITCHNAMEDXXXXXXXXXXXX", label: "prod", serving: "ready" },
      {
        id: "01HSWITCHUNNAMEDXXXXXXXXXX",
        label: "01HSWITCHUNN",
        serving: "ready",
      },
    ]);
  });

  it("paused wins over broken; zero databases reads broken", async () => {
    handle.queueSelect([
      {
        id: "conn-paused",
        name: "staging",
        // Paused wins even over a database-less project — deliberate owner
        // action, Resume is the unambiguous next step.
        pausedAt: new Date("2026-07-02T00:00:00Z"),
        databaseCount: 0,
      },
      {
        id: "conn-empty",
        name: "empty",
        pausedAt: null,
        databaseCount: 0, // nothing for the engine to bind → broken
      },
    ]);
    const { listProjectSwitcherRows } = await import("../src/lib/projects.ts");

    const rows = await listProjectSwitcherRows(customer);

    expect(rows.map((r) => r.serving)).toEqual(["paused", "broken"]);
  });

  it("returns [] for a customer with no projects", async () => {
    handle.queueSelect([]);
    const { listProjectSwitcherRows } = await import("../src/lib/projects.ts");
    expect(await listProjectSwitcherRows(customer)).toEqual([]);
  });
});

// listDashboardProjects + getDashboardFreshness both lead with
// Promise.all([parentsChain, lastQueryByDatabase()]), which doesn't drain
// in source order: the inner `await` inside lastQueryByDatabase schedules
// its microtask BEFORE Promise.all schedules its iteration microtasks, so
// the audit aggregate drains before parents.
//
// getDashboardFreshness then reads children sequentially → drain order:
//   1. audit aggregate  2. parents  3. children
//
// listDashboardProjects wraps children in a SECOND
// Promise.all([childrenChain, countActiveTokensByProject()]). Same
// quirk: the token-count inner await drains before the lazy children
// chain → drain order:
//   1. audit aggregate  2. parents  3. token count  4. children
// Tests queue rows in that order. countActiveTokensByProject rows are
// { projectId, count }; an empty queue entry means "no active tokens"
// and the row falls back to activeTokens: 0.

describe("listDashboardProjects", () => {
  it("plumbs per-DB lastQueryAt from audit_events_index into each row", async () => {
    const indexedAt = new Date("2026-04-30T10:00:00Z");
    const mainQueryAt = new Date("2026-04-30T11:30:00Z");
    const analyticsQueryAt = new Date("2026-04-30T11:45:00Z");
    // 1) audit aggregate (inner await fires first). 0020: keyed by
    // (project_id, database), so each row carries its project id.
    handle.queueSelect([
      { projectId: "conn-1", database: "main", lastQueryAt: mainQueryAt },
      {
        projectId: "conn-1",
        database: "analytics",
        lastQueryAt: analyticsQueryAt,
      },
    ]);
    // 2) parents query (Promise.all microtask)
    handle.queueSelect([
      {
        project: {
          id: "conn-1",
          customerId: customer.id,
          region: "eu",
          name: "prod",
          createdAt: new Date(),
        },
        lastIndexedAt: indexedAt,
        lastErrorAt: null,
      },
    ]);
    // 3) token count (countActiveTokensByProject inner await)
    handle.queueSelect([{ projectId: "conn-1", count: 2 }]);
    // 4) children query (sequential after the second Promise.all)
    handle.queueSelect([
      {
        id: "cdb-main",
        projectId: "conn-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
      },
      {
        id: "cdb-analytics",
        projectId: "conn-1",
        name: "analytics",
        tableAccess: { default: "deny", tables: {} },
      },
    ]);
    const { listDashboardProjects } = await import(
      "../src/lib/projects.ts"
    );

    const rows = await listDashboardProjects(customer);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.cursor.lastIndexedAt).toEqual(indexedAt);
    expect(rows[0]!.databases).toHaveLength(2);
    const byName = new Map(rows[0]!.databases.map((d) => [d.name, d]));
    expect(byName.get("main")?.lastQueryAt).toEqual(mainQueryAt);
    expect(byName.get("analytics")?.lastQueryAt).toEqual(analyticsQueryAt);
    expect(rows[0]!.activeTokens).toBe(2);
  });

  it("returns lastQueryAt: null when audit aggregate has no row for that DB", async () => {
    handle.queueSelect([]); // 1) audit: no rows yet (inner await first)
    handle.queueSelect([
      {
        project: {
          id: "conn-1",
          customerId: customer.id,
          region: "eu",
          name: null,
          createdAt: new Date(),
        },
        lastIndexedAt: null,
        lastErrorAt: null,
      },
    ]); // 2) parents
    handle.queueSelect([]); // 3) token count: none active → activeTokens 0
    handle.queueSelect([
      {
        id: "cdb-main",
        projectId: "conn-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
      },
    ]); // 4) children
    const { listDashboardProjects } = await import(
      "../src/lib/projects.ts"
    );

    const rows = await listDashboardProjects(customer);
    expect(rows[0]!.databases[0]!.lastQueryAt).toBeNull();
    expect(rows[0]!.activeTokens).toBe(0);
  });

  it("coerces driver-returned ISO strings on the audit aggregate to real Dates", async () => {
    const isoString = "2026-04-30T11:30:00.000Z";
    handle.queueSelect([
      { projectId: "conn-1", database: "main", lastQueryAt: isoString },
    ]); // 1) audit
    handle.queueSelect([
      {
        project: {
          id: "conn-1",
          customerId: customer.id,
          region: "eu",
          name: null,
          createdAt: new Date(),
        },
        lastIndexedAt: null,
        lastErrorAt: null,
      },
    ]); // 2) parents
    handle.queueSelect([{ projectId: "conn-1", count: 3 }]); // 3) token count
    handle.queueSelect([
      {
        id: "cdb-main",
        projectId: "conn-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
      },
    ]); // 4) children
    const { listDashboardProjects } = await import(
      "../src/lib/projects.ts"
    );

    const rows = await listDashboardProjects(customer);
    expect(rows[0]!.databases[0]!.lastQueryAt).toBeInstanceOf(Date);
    expect((rows[0]!.databases[0]!.lastQueryAt as Date).toISOString()).toBe(
      isoString,
    );
    expect(rows[0]!.activeTokens).toBe(3);
  });

  it("scopes lastQueryAt per project — same-named DBs in different projects don't share a timestamp (0020)", async () => {
    // Before 0020 the aggregate grouped by DB name only, so two projects
    // each with a "main" DB collided on one timestamp. The fake ignores the
    // WHERE/GROUP BY, so we exercise the call-site shape: the map is keyed by
    // (project_id, database) and each child looks up its own composite
    // key. Distinct timestamps in → distinct timestamps out.
    const conn1Main = new Date("2026-05-01T10:00:00Z");
    const conn2Main = new Date("2026-05-01T12:00:00Z");
    // 1) audit aggregate — same DB name "main" under two project ids.
    handle.queueSelect([
      { projectId: "conn-1", database: "main", lastQueryAt: conn1Main },
      { projectId: "conn-2", database: "main", lastQueryAt: conn2Main },
    ]);
    // 2) parents — two projects.
    handle.queueSelect([
      {
        project: {
          id: "conn-1",
          customerId: customer.id,
          region: "eu",
          name: "alpha",
          createdAt: new Date(),
        },
        lastIndexedAt: null,
        lastErrorAt: null,
      },
      {
        project: {
          id: "conn-2",
          customerId: customer.id,
          region: "eu",
          name: "beta",
          createdAt: new Date(),
        },
        lastIndexedAt: null,
        lastErrorAt: null,
      },
    ]);
    // 3) token count — none.
    handle.queueSelect([]);
    // 4) children — each project's "main" DB (IN-list across both parents).
    handle.queueSelect([
      {
        id: "cdb-1",
        projectId: "conn-1",
        name: "main",
        tableAccess: { default: "read", tables: {} },
      },
      {
        id: "cdb-2",
        projectId: "conn-2",
        name: "main",
        tableAccess: { default: "read", tables: {} },
      },
    ]);
    const { listDashboardProjects } = await import(
      "../src/lib/projects.ts"
    );

    const rows = await listDashboardProjects(customer);
    const byId = new Map(rows.map((r) => [r.project.id, r]));
    expect(byId.get("conn-1")!.databases[0]!.lastQueryAt).toEqual(conn1Main);
    expect(byId.get("conn-2")!.databases[0]!.lastQueryAt).toEqual(conn2Main);
  });
});

describe("getDashboardFreshness", () => {
  it("returns the slim freshness shape without policy / ciphertext", async () => {
    const indexedAt = new Date("2026-04-30T10:00:00Z");
    const mainQueryAt = new Date("2026-04-30T11:30:00Z");
    // Same drain order as listDashboardProjects — audit first, then
    // parents, then children. 0020: aggregate keyed by (project_id, db).
    handle.queueSelect([
      { projectId: "conn-1", database: "main", lastQueryAt: mainQueryAt },
    ]);
    handle.queueSelect([
      {
        id: "conn-1",
        pausedAt: null,
        lastIndexedAt: indexedAt,
        lastErrorAt: null,
      },
    ]);
    handle.queueSelect([{ projectId: "conn-1", name: "main" }]);
    const { getDashboardFreshness } = await import(
      "../src/lib/projects.ts"
    );

    const snapshot = await getDashboardFreshness(customer);

    expect(snapshot.projects).toHaveLength(1);
    const c = snapshot.projects[0]!;
    expect(c.id).toBe("conn-1");
    expect(c.pausedAt).toBeNull();
    expect(c.cursor.lastIndexedAt).toEqual(indexedAt);
    expect(c.databases).toEqual([
      { name: "main", lastQueryAt: mainQueryAt },
    ]);
    // PR2 of mcp_url_auth_security: the project row no longer carries
    // mcp_token at all. Assert it doesn't appear in the freshness payload
    // as a regression guard — if a future schema migration re-introduces
    // a plaintext token column, the polling endpoint should still hold
    // the line.
    expect((c as Record<string, unknown>).mcpToken).toBeUndefined();
  });

  it("carries pausedAt so the dashboard dots can reflect the kill switch", async () => {
    const pausedAt = new Date("2026-04-30T12:00:00Z");
    handle.queueSelect([]); // no audit rows
    handle.queueSelect([
      { id: "conn-1", pausedAt, lastIndexedAt: null, lastErrorAt: null },
    ]);
    handle.queueSelect([{ projectId: "conn-1", name: "main" }]);
    const { getDashboardFreshness } = await import(
      "../src/lib/projects.ts"
    );

    const snapshot = await getDashboardFreshness(customer);

    expect(snapshot.projects[0]!.pausedAt).toEqual(pausedAt);
  });
});
