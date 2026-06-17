// Unit coverage for the tokens lib (apps/web/src/lib/tokens.ts).
//
// Same pattern as connections.test.ts: a hand-rolled fake DB that records
// every operation and lets each test stage the next select/insert/update
// result. The real @midplane-cloud/kms/pepper module is used (pure crypto,
// no IO) so the createToken happy-path test can re-hash the returned
// plaintext and assert it matches the bytea that landed in the captured
// insert.
//
// Concurrency posture (FOR UPDATE on the parent + pre-check + unique
// constraint) is verified at the integration layer against a real
// Postgres; the fake here doesn't model row locks, but it does assert
// the lock chain was issued.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

import { hashToken } from "@midplane-cloud/kms/pepper";

interface DbCall {
  op: "select" | "insert" | "update" | "execute";
  table?: unknown;
  set?: unknown;
  where?: unknown;
  forUpdate?: boolean;
}

interface FakeDbHandle {
  db: object;
  calls: DbCall[];
  /** Push the result for the NEXT select() call. Drains in FIFO order. */
  queueSelect(rows: unknown[]): void;
  /** Make the next insert reject with the given error. */
  failNextInsert(err: unknown): void;
}

let handle: FakeDbHandle;

function makeFakeDb(): FakeDbHandle {
  const calls: DbCall[] = [];
  const selectQueue: Array<unknown[]> = [];
  const insertErrorQueue: unknown[] = [];

  const startSelect = () => {
    let table: unknown;
    let whereValue: unknown;
    let forUpdate = false;
    const resolveRows = () =>
      selectQueue.length > 0 ? selectQueue.shift()! : [];
    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      where(c: unknown) {
        whereValue = c;
        return chain;
      },
      for() {
        forUpdate = true;
        return chain;
      },
      limit() {
        calls.push({ op: "select", table, where: whereValue, forUpdate });
        return Promise.resolve(resolveRows());
      },
      orderBy() {
        calls.push({ op: "select", table, where: whereValue, forUpdate });
        return Promise.resolve(resolveRows());
      },
      then(onFulfilled: (rows: unknown[]) => unknown) {
        calls.push({ op: "select", table, where: whereValue, forUpdate });
        return Promise.resolve(resolveRows()).then(onFulfilled);
      },
    };
    return chain;
  };

  const startMutation = (op: "update" | "insert", table: unknown) => {
    let setValue: unknown;
    let whereValue: unknown;
    const chain = {
      set(v: unknown) {
        setValue = v;
        return chain;
      },
      values(row: unknown) {
        calls.push({ op: "insert", table, set: row });
        if (insertErrorQueue.length > 0) {
          return Promise.reject(insertErrorQueue.shift());
        }
        return Promise.resolve();
      },
      where(c: unknown) {
        whereValue = c;
        return chain;
      },
      then(onFulfilled: (rows: unknown[]) => unknown) {
        calls.push({ op, table, set: setValue, where: whereValue });
        return Promise.resolve([]).then(onFulfilled);
      },
    };
    return chain;
  };

  const makeRoot = () => ({
    select(_fields?: unknown) {
      return startSelect();
    },
    insert(t: unknown) {
      return startMutation("insert", t);
    },
    update(t: unknown) {
      return startMutation("update", t);
    },
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
  });

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
    queueSelect(rows) {
      selectQueue.push(rows);
    },
    failNextInsert(err) {
      insertErrorQueue.push(err);
    },
  };
}

vi.mock("@midplane-cloud/db", async () => {
  const real = await vi.importActual<typeof import("@midplane-cloud/db")>(
    "@midplane-cloud/db",
  );
  return {
    ...real,
    getDb: (_region: "eu" | "us") => handle.db,
  };
});

beforeEach(() => {
  handle = makeFakeDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

const customer = {
  // ULID literal — emitTokenAuditRow validates customer.id matches the
  // ULID alphabet before SET LOCAL inlines it.
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  orgId: "org_clerk-1",
  email: "u@e.test",
  region: "eu" as const,
  planOverride: null,
  plan: "free" as const,
  ownerEmail: null,
  createdAt: new Date(),
};

const pepper = { kid: "v1-eu", pepper: randomBytes(32) };

describe("createToken", () => {
  it("happy path: inserts a row whose token_hash matches HMAC(pepper, returned plaintext)", async () => {
    handle.queueSelect([{ id: "conn-1" }]); // parent ownership read
    handle.queueSelect([]); // sibling-collision pre-check (empty)

    const { mcpTokens, auditEventsIndex } = await import("@midplane-cloud/db");
    const { createToken } = await import("../src/lib/tokens.ts");

    const result = await createToken(
      customer,
      "conn-1",
      {
        name: "laptop",
        expiresAt: null,
        actorUserId: "user_clerk_1",
        env: "test",
      },
      pepper,
    );

    expect(result).not.toBeNull();
    expect(result!.plaintext).toMatch(
      /^mp_test_[0-9a-f]{32}_[0-9A-HJKMNP-Z]{6}$/,
    );

    const insert = handle.calls.find(
      (c) => c.op === "insert" && c.table === mcpTokens,
    );
    expect(insert).toBeDefined();
    const row = insert!.set as Record<string, unknown>;
    expect(row.connectionId).toBe("conn-1");
    expect(row.name).toBe("laptop");
    expect(row.prefix).toBe("mp_test");
    expect((row.last4 as string).length).toBe(4);
    expect(row.pepperKid).toBe("v1-eu");
    expect(row.createdByUserId).toBe("user_clerk_1");
    expect(row.expiresAt).toBeNull();

    // Re-hash the returned plaintext under the same pepper — must match the
    // bytea that landed in the row. Proves the show-once URL the dashboard
    // hands the user is the exact value we'd need to reproduce on lookup.
    const expectedHash = hashToken(pepper.pepper, result!.plaintext);
    expect((row.tokenHash as Buffer).equals(expectedHash)).toBe(true);

    // Audit row landed with TOKEN_CREATED + the mcp_token_id stamped.
    const auditInsert = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(auditInsert).toBeDefined();
    const auditRow = auditInsert!.set as Record<string, unknown>;
    expect(auditRow.eventType).toBe("TOKEN_CREATED");
    expect(auditRow.mcpTokenId).toBe(row.id);
    expect(auditRow.actorUserId).toBe("user_clerk_1");
  });

  it("issues the parent SELECT … FOR UPDATE before the sibling pre-check", async () => {
    handle.queueSelect([{ id: "conn-1" }]);
    handle.queueSelect([]);
    const { createToken } = await import("../src/lib/tokens.ts");
    await createToken(
      customer,
      "conn-1",
      {
        name: "ci",
        expiresAt: null,
        actorUserId: "user_clerk_1",
        env: "test",
      },
      pepper,
    );
    const selects = handle.calls.filter((c) => c.op === "select");
    expect(selects[0]?.forUpdate).toBe(true);
    expect(selects[1]?.forUpdate).toBe(false);
  });

  it("throws PlanLimitError('tokens') when planLimit is set and usable tokens are at the cap", async () => {
    handle.queueSelect([{ id: customer.id }]); // customers FOR UPDATE
    handle.queueSelect([{ id: "conn-1" }]); // countUsableTokens: connection ids
    handle.queueSelect([{ count: 1 }]); // usable token count → 1 >= cap 1
    const { createToken } = await import("../src/lib/tokens.ts");
    const { PlanLimitError } = await import("../src/lib/plan.ts");
    const err = await createToken(
      customer,
      "conn-1",
      {
        name: "x",
        expiresAt: null,
        actorUserId: "user_clerk_1",
        env: "test",
        planLimit: { tokenCap: 1, plan: "free" },
      },
      pepper,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(PlanLimitError);
    expect(err.resource).toBe("tokens");
    expect(err.limit).toBe(1);
  });

  it("locks the customers row BEFORE the connection when enforcing the token cap", async () => {
    handle.queueSelect([{ id: customer.id }]); // customers FOR UPDATE
    handle.queueSelect([{ id: "conn-1" }]); // countUsableTokens: connection ids
    handle.queueSelect([{ count: 0 }]); // usable token count → 0 < cap 5 ✓
    handle.queueSelect([{ id: "conn-1" }]); // parent connection FOR UPDATE
    handle.queueSelect([]); // name collision pre-check (none)
    const { customers, connections } = await import("@midplane-cloud/db");
    const { createToken } = await import("../src/lib/tokens.ts");
    const result = await createToken(
      customer,
      "conn-1",
      {
        name: "ok",
        expiresAt: null,
        actorUserId: "user_clerk_1",
        env: "test",
        planLimit: { tokenCap: 5, plan: "pro" },
      },
      pepper,
    );
    expect(result).not.toBeNull();
    const selects = handle.calls.filter((c) => c.op === "select");
    // First lock is the customers row (cap serialization), and it precedes
    // the connection lock — consistent lock order with createConnection.
    expect(selects[0]?.table).toBe(customers);
    expect(selects[0]?.forUpdate).toBe(true);
    expect(selects.some((s) => s.table === connections && s.forUpdate)).toBe(
      true,
    );
  });

  it("throws DuplicateTokenName when the pre-check finds a sibling with the same name", async () => {
    handle.queueSelect([{ id: "conn-1" }]); // parent ok
    handle.queueSelect([{ id: "existing-token" }]); // collision
    const { createToken, DuplicateTokenName } = await import(
      "../src/lib/tokens.ts"
    );
    await expect(
      createToken(
        customer,
        "conn-1",
        {
          name: "laptop",
          expiresAt: null,
          actorUserId: "u",
          env: "test",
        },
        pepper,
      ),
    ).rejects.toBeInstanceOf(DuplicateTokenName);
  });

  it("translates a unique_violation from the driver into DuplicateTokenName", async () => {
    handle.queueSelect([{ id: "conn-1" }]);
    handle.queueSelect([]); // pre-check clean
    handle.failNextInsert(
      Object.assign(new Error("dup"), {
        code: "23505",
        constraint_name: "mcp_tokens_name_per_connection_uq",
      }),
    );
    const { createToken, DuplicateTokenName } = await import(
      "../src/lib/tokens.ts"
    );
    await expect(
      createToken(
        customer,
        "conn-1",
        {
          name: "racer",
          expiresAt: null,
          actorUserId: "u",
          env: "test",
        },
        pepper,
      ),
    ).rejects.toBeInstanceOf(DuplicateTokenName);
  });

  it("throws ExpiryInThePast when expiresAt is in the past", async () => {
    const { createToken, ExpiryInThePast } = await import(
      "../src/lib/tokens.ts"
    );
    await expect(
      createToken(
        customer,
        "conn-1",
        {
          name: "laptop",
          expiresAt: new Date(Date.now() - 60_000),
          actorUserId: "u",
          env: "test",
        },
        pepper,
      ),
    ).rejects.toBeInstanceOf(ExpiryInThePast);
  });

  it("returns null on foreign connection (parent ownership read returns 0 rows)", async () => {
    handle.queueSelect([]); // parent not found / not owned
    const { createToken } = await import("../src/lib/tokens.ts");
    const result = await createToken(
      customer,
      "someone-elses-conn",
      {
        name: "x",
        expiresAt: null,
        actorUserId: "u",
        env: "test",
      },
      pepper,
    );
    expect(result).toBeNull();
  });
});

describe("listTokens", () => {
  it("happy path: returns rows for an owned connection", async () => {
    handle.queueSelect([{ id: "conn-1" }]); // parent ownership
    handle.queueSelect([
      {
        id: "tok-1",
        name: "laptop",
        prefix: "mp_test",
        last4: "ab12",
        createdByUserId: "u",
        createdAt: new Date(),
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        lastUsedUa: null,
        status: "active",
        revokedAt: null,
        revokedReason: null,
      },
    ]);
    const { listTokens } = await import("../src/lib/tokens.ts");
    const rows = await listTokens(customer, "conn-1");
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows![0]!.id).toBe("tok-1");
    expect(rows![0]!.status).toBe("active");
  });

  it("returns null on foreign connection", async () => {
    handle.queueSelect([]); // parent not owned
    const { listTokens } = await import("../src/lib/tokens.ts");
    const rows = await listTokens(customer, "foreign");
    expect(rows).toBeNull();
  });
});

describe("revokeToken", () => {
  it("happy path: transitions active → revoked + writes audit row", async () => {
    handle.queueSelect([{ id: "conn-1" }]); // parent
    handle.queueSelect([{ id: "tok-1", status: "active" }]); // existing
    const { mcpTokens, auditEventsIndex } = await import(
      "@midplane-cloud/db"
    );
    const { revokeToken } = await import("../src/lib/tokens.ts");
    const result = await revokeToken(customer, "conn-1", "tok-1", {
      reason: "user_action",
      actorUserId: "u",
    });
    expect(result).toEqual({ id: "tok-1" });

    const update = handle.calls.find(
      (c) => c.op === "update" && c.table === mcpTokens,
    );
    expect(update).toBeDefined();
    const set = update!.set as Record<string, unknown>;
    expect(set.status).toBe("revoked");
    expect(set.revokedReason).toBe("user_action");
    expect(set.revokedAt).toBeInstanceOf(Date);

    const audit = handle.calls.find(
      (c) => c.op === "insert" && c.table === auditEventsIndex,
    );
    expect(audit).toBeDefined();
    const auditRow = audit!.set as Record<string, unknown>;
    expect(auditRow.eventType).toBe("TOKEN_REVOKED");
    expect(auditRow.mcpTokenId).toBe("tok-1");
  });

  it("idempotent on already-revoked: returns the row, no UPDATE, no audit", async () => {
    handle.queueSelect([{ id: "conn-1" }]);
    handle.queueSelect([{ id: "tok-1", status: "revoked" }]);
    const { mcpTokens, auditEventsIndex } = await import(
      "@midplane-cloud/db"
    );
    const { revokeToken } = await import("../src/lib/tokens.ts");
    const result = await revokeToken(customer, "conn-1", "tok-1", {
      reason: "user_action",
      actorUserId: "u",
    });
    expect(result).toEqual({ id: "tok-1" });
    expect(
      handle.calls.some((c) => c.op === "update" && c.table === mcpTokens),
    ).toBe(false);
    expect(
      handle.calls.some(
        (c) => c.op === "insert" && c.table === auditEventsIndex,
      ),
    ).toBe(false);
  });

  it("returns null on foreign connection", async () => {
    handle.queueSelect([]); // parent not owned
    const { revokeToken } = await import("../src/lib/tokens.ts");
    const result = await revokeToken(customer, "foreign", "tok-x", {
      reason: "user_action",
      actorUserId: "u",
    });
    expect(result).toBeNull();
  });

  it("returns null when the token id doesn't exist on the connection", async () => {
    handle.queueSelect([{ id: "conn-1" }]); // parent ok
    handle.queueSelect([]); // token not found
    const { revokeToken } = await import("../src/lib/tokens.ts");
    const result = await revokeToken(customer, "conn-1", "missing-tok", {
      reason: "user_action",
      actorUserId: "u",
    });
    expect(result).toBeNull();
  });
});

describe("lookupByPlaintext", () => {
  it("returns null on malformed input WITHOUT touching the DB", async () => {
    const { lookupByPlaintext } = await import("../src/lib/tokens.ts");
    const result = await lookupByPlaintext(
      "not-a-token",
      "eu",
      new Map([[pepper.kid, pepper.pepper]]),
    );
    expect(result).toBeNull();
    // Mock counter — if the lib bypassed parseToken / validateChecksum,
    // a select would have been recorded.
    expect(handle.calls).toHaveLength(0);
  });

  it("returns null on a structurally-valid token whose CRC is wrong (no DB hit)", async () => {
    const { generateToken } = await import("@midplane-cloud/db");
    const { plaintext } = generateToken("test");
    // Re-pack the token with a flipped CRC.
    const swap = plaintext.slice(-6)[0] === "0" ? "1" : "0";
    const broken = plaintext.slice(0, -6) + swap + plaintext.slice(-5);
    const { lookupByPlaintext } = await import("../src/lib/tokens.ts");
    const result = await lookupByPlaintext(
      broken,
      "eu",
      new Map([[pepper.kid, pepper.pepper]]),
    );
    expect(result).toBeNull();
    expect(handle.calls).toHaveLength(0);
  });

  it("happy path: resolves a known hash to (tokenId, connectionId)", async () => {
    const { generateToken } = await import("@midplane-cloud/db");
    const { plaintext } = generateToken("test");
    handle.queueSelect([{ id: "tok-1", connectionId: "conn-1" }]);
    const { lookupByPlaintext } = await import("../src/lib/tokens.ts");
    const result = await lookupByPlaintext(
      plaintext,
      "eu",
      new Map([[pepper.kid, pepper.pepper]]),
    );
    expect(result).toEqual({ tokenId: "tok-1", connectionId: "conn-1" });
  });

  it("returns null when the hash does not match any row (unknown / revoked / expired)", async () => {
    const { generateToken } = await import("@midplane-cloud/db");
    const { plaintext } = generateToken("test");
    handle.queueSelect([]); // no match
    const { lookupByPlaintext } = await import("../src/lib/tokens.ts");
    const result = await lookupByPlaintext(
      plaintext,
      "eu",
      new Map([[pepper.kid, pepper.pepper]]),
    );
    expect(result).toBeNull();
  });

  it("rejects a token hashed under a kid not in the caller's pepper map (rotation resilience)", async () => {
    // Simulate: the token landed in the DB hashed with pepperA / kid v0,
    // and our lookup map only carries pepperB / kid v1. The lookup hashes
    // with pepperB, the resulting bytea never matches the row's
    // token_hash, the query returns no rows, and we return null.
    const { generateToken } = await import("@midplane-cloud/db");
    const { plaintext } = generateToken("test");
    const otherPepper = randomBytes(32);
    handle.queueSelect([]); // no row matches our (wrong) hash
    const { lookupByPlaintext } = await import("../src/lib/tokens.ts");
    const result = await lookupByPlaintext(
      plaintext,
      "eu",
      new Map([["v1-eu", otherPepper]]),
    );
    expect(result).toBeNull();
  });
});

describe("countUsableTokens", () => {
  it("returns 0 without a count query when the customer has no connections", async () => {
    handle.queueSelect([]); // connection ids → none
    const { countUsableTokens } = await import("../src/lib/tokens.ts");
    const n = await countUsableTokens(
      handle.db as unknown as Parameters<typeof countUsableTokens>[0],
      customer.id,
    );
    expect(n).toBe(0);
    // Only the connection-ids select ran; no token count for an empty set.
    expect(handle.calls.filter((c) => c.op === "select")).toHaveLength(1);
  });

  it("sums the usable-token count across the customer's connections", async () => {
    handle.queueSelect([{ id: "c1" }, { id: "c2" }]); // connection ids
    handle.queueSelect([{ count: 3 }]); // usable count
    const { countUsableTokens } = await import("../src/lib/tokens.ts");
    const n = await countUsableTokens(
      handle.db as unknown as Parameters<typeof countUsableTokens>[0],
      customer.id,
    );
    expect(n).toBe(3);
  });
});
