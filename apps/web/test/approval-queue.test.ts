// Unit coverage for the /approvals queue reads (apps/web/src/lib/approval-queue.ts).
//
// The SQL semantics (atomic deadline predicate, partial unique index) are
// proven against real Postgres in approvals-live.test.ts, which is gated on a
// DSN. This file pins the ORDERING contracts with a fake db so they run on
// every `vitest run`: the queue sweeps before it selects, the detail read
// relabels only its own row, and a failed sweep never blanks the page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface DbCall {
  op: "select" | "update";
  table?: unknown;
  set?: unknown;
}

interface FakeDbHandle {
  db: object;
  calls: DbCall[];
  /** Rows for the NEXT terminal select. FIFO. */
  queueSelect(rows: unknown[]): void;
  /** Rows for the NEXT update().returning(). FIFO. */
  queueReturning(rows: unknown[]): void;
}

let handle: FakeDbHandle;

function makeFakeDb(): FakeDbHandle {
  const calls: DbCall[] = [];
  const selectQueue: Array<unknown[]> = [];
  const returningQueue: Array<unknown[]> = [];

  const startSelect = () => {
    let table: unknown;
    const finish = () => {
      calls.push({ op: "select", table });
      return Promise.resolve(selectQueue.shift() ?? []);
    };
    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      leftJoin() {
        return chain;
      },
      innerJoin() {
        return chain;
      },
      where() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      limit() {
        return finish();
      },
      then(
        onFulfilled: (rows: unknown[]) => unknown,
        onRejected?: (err: unknown) => unknown,
      ) {
        return finish().then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  const startUpdate = (table: unknown) => {
    let setValue: unknown;
    const record = () => calls.push({ op: "update", table, set: setValue });
    const chain = {
      set(v: unknown) {
        setValue = v;
        return chain;
      },
      where() {
        return chain;
      },
      returning() {
        record();
        return Promise.resolve(returningQueue.shift() ?? []);
      },
      then(
        onFulfilled: (rows: unknown[]) => unknown,
        onRejected?: (err: unknown) => unknown,
      ) {
        record();
        return Promise.resolve([]).then(onFulfilled, onRejected);
      },
    };
    return chain;
  };

  const db = {
    select() {
      return startSelect();
    },
    update(t: unknown) {
      return startUpdate(t);
    },
  };

  return {
    db,
    calls,
    queueSelect(rows) {
      selectQueue.push(rows);
    },
    queueReturning(rows) {
      returningQueue.push(rows);
    },
  };
}

vi.mock("@midplane-cloud/db", async () => {
  const real = await vi.importActual<typeof import("@midplane-cloud/db")>(
    "@midplane-cloud/db",
  );
  return { ...real, getDb: () => handle.db };
});

vi.mock("@/lib/approvals", () => ({ expireStaleApprovals: vi.fn() }));

async function sweepMock() {
  const { expireStaleApprovals } = await import("@/lib/approvals");
  return vi.mocked(expireStaleApprovals);
}

/** A raw joined row in the shape SELECTION produces. */
function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    projectId: "p1",
    projectName: "shop",
    database: "main",
    sqlText: "UPDATE orders SET status='refunded' WHERE id=1",
    intent: "refund the duplicate charge",
    statementType: "UPDATE",
    tablesTouched: ["orders"],
    agentName: "Claude Code",
    status: "pending",
    decidedByUserId: null,
    decidedByName: null,
    decidedByEmail: null,
    requestedByName: null,
    requestedByEmail: null,
    agentKind: null,
    executedAuditId: null,
    executedPayload: null,
    executedAt: null,
    decisionNote: null,
    decidedAt: null,
    expiresAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 120_000),
    ...overrides,
  };
}

beforeEach(async () => {
  handle = makeFakeDb();
  (await sweepMock()).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queue reads sweep before they select", () => {
  it("listPendingApprovals runs the region sweep first", async () => {
    const sweep = await sweepMock();
    sweep.mockImplementation(async () => {
      // Nothing has been selected yet when the sweep runs.
      expect(handle.calls).toHaveLength(0);
      return 0;
    });
    handle.queueSelect([rawRow()]);
    const { listPendingApprovals } = await import("../src/lib/approval-queue.ts");

    const rows = await listPendingApprovals("eu", "c1");
    // Scoped to the caller's workspace: a page load never sweeps other tenants.
    expect(sweep).toHaveBeenCalledWith("eu", { customerId: "c1" });
    expect(rows).toHaveLength(1);
    expect(handle.calls.map((c) => c.op)).toEqual(["select"]);
  });

  it("listDecidedApprovals sweeps too — the page reads both tabs concurrently", async () => {
    const sweep = await sweepMock();
    sweep.mockImplementation(async () => {
      expect(handle.calls).toHaveLength(0);
      return 0;
    });
    handle.queueSelect([rawRow({ status: "expired", decidedAt: new Date() })]);
    const { listDecidedApprovals } = await import("../src/lib/approval-queue.ts");

    const rows = await listDecidedApprovals("eu", "c1");
    expect(sweep).toHaveBeenCalledWith("eu", { customerId: "c1" });
    expect(rows[0]!.status).toBe("expired");
  });

  it("a failed sweep never blanks the queue", async () => {
    const sweep = await sweepMock();
    sweep.mockRejectedValue(new Error("postgres outage"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    handle.queueSelect([rawRow()]);
    const { listPendingApprovals } = await import("../src/lib/approval-queue.ts");

    const rows = await listPendingApprovals("eu", "c1");
    expect(rows).toHaveLength(1);
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("expiry sweep before read failed"),
      expect.any(Error),
    );
  });
});

describe("getApproval", () => {
  it("relabels only the requested row, never the whole region", async () => {
    const sweep = await sweepMock();
    handle.queueSelect([rawRow({ status: "expired" })]);
    const { writeApprovals } = await import("@midplane-cloud/db");
    const { getApproval } = await import("../src/lib/approval-queue.ts");

    const row = await getApproval("eu", "c1", "a1");
    expect(row?.status).toBe("expired");
    // A single-approval read is a tenant-scoped write, not a region-wide one.
    expect(sweep).not.toHaveBeenCalled();
    expect(handle.calls.map((c) => c.op)).toEqual(["update", "select"]);
    expect(handle.calls[0]!.table).toBe(writeApprovals);
    const set = handle.calls[0]!.set as Record<string, unknown>;
    expect(set.status).toBe("expired");
    expect(set.decidedByUserId).toBeUndefined();
  });

  it("still reads when the relabel fails", async () => {
    // Force the relabel UPDATE to reject by making the fake's update chain throw.
    const broken = {
      ...handle.db,
      update() {
        throw new Error("postgres outage");
      },
    };
    handle = { ...handle, db: broken };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    handle.queueSelect([rawRow()]);
    const { getApproval } = await import("../src/lib/approval-queue.ts");

    const row = await getApproval("eu", "c1", "a1");
    expect(row?.id).toBe("a1");
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining("expiry relabel before read failed"),
      expect.any(Error),
    );
  });
});

describe("decideApproval on a request whose window closed", () => {
  const args = {
    region: "eu" as const,
    customerId: "c1",
    id: "a1",
    decision: "approved" as const,
    userId: "u1",
    note: null,
  };

  it("reports expiry when the read-back already carries the relabel", async () => {
    handle.queueReturning([]); // the deadline predicate refused the decision
    handle.queueSelect([rawRow({ status: "expired" })]); // read-back
    const { decideApproval } = await import("../src/lib/approval-queue.ts");

    expect(await decideApproval(args)).toEqual({ ok: false, error: "expired" });
  });

  it("relabels the row itself when the inline relabel did not land", async () => {
    handle.queueReturning([]);
    handle.queueSelect([rawRow({ status: "pending" })]); // read-back still pending
    const { decideApproval } = await import("../src/lib/approval-queue.ts");

    expect(await decideApproval(args)).toEqual({ ok: false, error: "expired" });
    const relabels = handle.calls.filter(
      (c) => c.op === "update" && (c.set as Record<string, unknown>).status === "expired",
    );
    // One inside getApproval's read-back, one in the decide fallback. Neither
    // credits a human with a decision they did not make.
    expect(relabels.length).toBeGreaterThanOrEqual(2);
    for (const r of relabels) {
      expect((r.set as Record<string, unknown>).decidedByUserId).toBeUndefined();
    }
  });

  it("reports someone else's decision as already_decided, not expiry", async () => {
    handle.queueReturning([]);
    handle.queueSelect([rawRow({ status: "denied", decidedByUserId: "u2" })]);
    const { decideApproval } = await import("../src/lib/approval-queue.ts");

    expect(await decideApproval(args)).toEqual({ ok: false, error: "already_decided" });
  });

  it("reports a foreign or missing id as not_found", async () => {
    handle.queueReturning([]);
    handle.queueSelect([]);
    const { decideApproval } = await import("../src/lib/approval-queue.ts");

    expect(await decideApproval(args)).toEqual({ ok: false, error: "not_found" });
  });
});
