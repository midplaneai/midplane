// Connect-pane live confirmation — the pure state machine + decision
// classifier, plus the getConnectStatus leakage shape (foreign project →
// null) against a minimal fake db. The SQL fact-queries themselves follow
// the same shapes the dashboard freshness read exercises against a migrated
// Postgres.

import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  classifyFirstQueryDecision,
  deriveConnectStatus,
  serializeConnectStatus,
  type ConnectFacts,
} from "../src/lib/connect-status.ts";

const NO_FACTS: ConnectFacts = {
  oauthAgentPresent: false,
  grantedDatabases: 0,
  urlTokenUsed: false,
  firstQuery: null,
  hasSecondQuery: false,
  lastQueryAt: null,
};

describe("classifyFirstQueryDecision", () => {
  it("EXECUTED implies allow (the engine never executes without DECIDED+allow)", () => {
    expect(
      classifyFirstQueryDecision({
        hasExecuted: true,
        hasMaskingBlock: false,
        decision: null,
      }),
    ).toBe("allow");
  });

  it("a column-masking block is a policy refusal (deny), even though it rides a FAILED row", () => {
    expect(
      classifyFirstQueryDecision({
        hasExecuted: false,
        hasMaskingBlock: true,
        decision: "allow",
      }),
    ).toBe("deny");
  });

  it("falls back to the DECIDED row's decision, case-insensitively", () => {
    expect(
      classifyFirstQueryDecision({
        hasExecuted: false,
        hasMaskingBlock: false,
        decision: "DENY",
      }),
    ).toBe("deny");
    expect(
      classifyFirstQueryDecision({
        hasExecuted: false,
        hasMaskingBlock: false,
        decision: "allow",
      }),
    ).toBe("allow");
  });

  it("allowed-but-failed execution still reads as decision=allow (decision axis, not outcome)", () => {
    // FAILED without a masking block: the query WAS allowed; execution
    // failing is a different axis the audit log details.
    expect(
      classifyFirstQueryDecision({
        hasExecuted: false,
        hasMaskingBlock: false,
        decision: "allow",
      }),
    ).toBe("allow");
  });

  it("no decision indexed yet → null (caller keeps polling)", () => {
    expect(
      classifyFirstQueryDecision({
        hasExecuted: false,
        hasMaskingBlock: false,
        decision: null,
      }),
    ).toBeNull();
    expect(
      classifyFirstQueryDecision({
        hasExecuted: false,
        hasMaskingBlock: false,
        decision: "something-unexpected",
      }),
    ).toBeNull();
  });
});

describe("deriveConnectStatus", () => {
  it("waiting when nothing has happened", () => {
    expect(deriveConnectStatus(NO_FACTS)).toEqual({
      phase: "waiting",
      grantedDatabases: 0,
      firstQuery: null,
      lastQuery: null,
    });
  });

  it("connected once an OAuth grant exists", () => {
    expect(
      deriveConnectStatus({
        ...NO_FACTS,
        oauthAgentPresent: true,
        grantedDatabases: 2,
      }),
    ).toEqual({
      phase: "connected",
      grantedDatabases: 2,
      firstQuery: null,
      lastQuery: null,
    });
  });

  it("connected when a machine token has been used (no OAuth grant needed)", () => {
    expect(
      deriveConnectStatus({ ...NO_FACTS, urlTokenUsed: true }).phase,
    ).toBe("connected");
  });

  it("connected_no_databases: approved client, zero grants — waiting would spin forever", () => {
    expect(
      deriveConnectStatus({ ...NO_FACTS, oauthAgentPresent: true }),
    ).toEqual({
      phase: "connected_no_databases",
      grantedDatabases: 0,
      firstQuery: null,
      lastQuery: null,
    });
  });

  it("a used machine token outranks the zero-grant warning (queries CAN flow)", () => {
    expect(
      deriveConnectStatus({
        ...NO_FACTS,
        oauthAgentPresent: true,
        urlTokenUsed: true,
      }).phase,
    ).toBe("connected");
  });

  // Revoked-agent grant residue is excluded at the READ layer (the grant
  // count's NOT EXISTS on a revoked attribution row for the client) — by the
  // time facts reach the derive, grantedDatabases only carries live grants.
  it("grants with NO attribution row still count (pre-consent-mint consents)", () => {
    expect(
      deriveConnectStatus({ ...NO_FACTS, grantedDatabases: 1 }).phase,
    ).toBe("connected");
  });

  it("a first query without a decision yet reads connected, not terminal", () => {
    const status = deriveConnectStatus({
      ...NO_FACTS,
      firstQuery: { decision: null, at: new Date("2026-07-17T10:00:00Z") },
    });
    expect(status.phase).toBe("connected");
    expect(status.firstQuery).toBeNull();
  });

  it("first_query carries the decision when no second query exists (allow and deny both)", () => {
    const at = new Date("2026-07-17T10:00:00Z");
    for (const decision of ["allow", "deny"] as const) {
      const status = deriveConnectStatus({
        ...NO_FACTS,
        oauthAgentPresent: true,
        grantedDatabases: 1,
        firstQuery: { decision, at },
        hasSecondQuery: false,
        lastQueryAt: at,
      });
      expect(status).toEqual({
        phase: "first_query",
        grantedDatabases: 1,
        firstQuery: { decision, at },
        lastQuery: { at },
      });
    }
  });

  it("graduates to active once a second query lands (live steady-state, not the frozen milestone)", () => {
    const first = new Date("2026-07-17T10:00:00Z");
    const last = new Date("2026-07-17T10:05:00Z");
    const status = deriveConnectStatus({
      ...NO_FACTS,
      oauthAgentPresent: true,
      grantedDatabases: 1,
      firstQuery: { decision: "allow", at: first },
      hasSecondQuery: true,
      lastQueryAt: last,
    });
    expect(status).toEqual({
      phase: "active",
      grantedDatabases: 1,
      firstQuery: { decision: "allow", at: first },
      lastQuery: { at: last },
    });
  });

  it("a second query but the first still undecided stays connected (decision leads)", () => {
    const status = deriveConnectStatus({
      ...NO_FACTS,
      firstQuery: { decision: null, at: new Date("2026-07-17T10:00:00Z") },
      hasSecondQuery: true,
      lastQueryAt: new Date("2026-07-17T10:02:00Z"),
    });
    expect(status.phase).toBe("connected");
  });
});

// Minimal fake db for the getConnectStatus read: every select resolves empty,
// transaction runs its callback with a no-op execute. Empty-everywhere is
// exactly the foreign-project shape (ownership miss + no facts).
function makeEmptyDb() {
  const chain = {
    from: () => chain,
    where: () => chain,
    innerJoin: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([]),
    then: (onFulfilled: (rows: unknown[]) => unknown) =>
      Promise.resolve([]).then(onFulfilled),
  };
  const root = {
    select: () => chain,
    selectDistinct: () => chain,
    execute: async () => ({ rows: [] }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(root),
  };
  return root;
}

vi.mock("@midplane-cloud/db", async () => {
  const real = await vi.importActual<typeof import("@midplane-cloud/db")>(
    "@midplane-cloud/db",
  );
  return { ...real, getDb: () => makeEmptyDb() };
});

const customer = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  orgId: "org_1",
  email: "u@e.test",
  region: "eu" as const,
  planOverride: null,
  plan: "free" as const,
  ownerEmail: null,
  createdAt: new Date("2026-07-01T00:00:00Z"),
};

describe("getConnectStatus", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns null for an unknown or foreign project (leakage-avoidance shape)", async () => {
    const { getConnectStatus } = await import("../src/lib/connect-status.ts");
    await expect(
      getConnectStatus(
        customer as Parameters<typeof getConnectStatus>[0],
        "conn-foreign",
      ),
    ).resolves.toBeNull();
  });

  it("rejects a non-ULID customer id (guards the SET LOCAL RLS bind inlining)", async () => {
    const { getConnectStatus } = await import("../src/lib/connect-status.ts");
    await expect(
      getConnectStatus(
        { ...customer, id: "bad'; DROP--" } as Parameters<
          typeof getConnectStatus
        >[0],
        "conn-1",
      ),
    ).rejects.toThrow(/ULID/);
  });
});

describe("serializeConnectStatus", () => {
  it("dates go out as ISO strings; null firstQuery/lastQuery survive", () => {
    const at = new Date("2026-07-17T10:00:00Z");
    const last = new Date("2026-07-17T10:05:00Z");
    expect(
      serializeConnectStatus({
        phase: "active",
        grantedDatabases: 1,
        firstQuery: { decision: "deny", at },
        lastQuery: { at: last },
      }),
    ).toEqual({
      phase: "active",
      grantedDatabases: 1,
      firstQuery: { decision: "deny", at: "2026-07-17T10:00:00.000Z" },
      lastQuery: { at: "2026-07-17T10:05:00.000Z" },
    });
    const waiting = serializeConnectStatus({
      phase: "waiting",
      grantedDatabases: 0,
      firstQuery: null,
      lastQuery: null,
    });
    expect(waiting.firstQuery).toBeNull();
    expect(waiting.lastQuery).toBeNull();
  });
});
