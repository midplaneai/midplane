// Unit coverage for the self-host signup gate (lib/self-host-gate.ts) — the
// security-critical data-isolation boundary. In self-host any authed account
// resolves to the one implicit customer, so SIGNUP is what we gate.
//
// We mock getDb to stage the invitation lookup (the invited-teammate exception)
// and the atomic owner-claim result, then assert the decision: invited email
// passes WITHOUT claiming owner; an uninvited second email is rejected; an
// expired/used invite does NOT open the gate; the first signup still becomes
// owner. Mirrors the getDb-mock style of seats.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Staged results consumed by the fake drizzle chains. `selectResults` is a
// FIFO of rows each `select()...where()` (or `.limit()`) call returns in order;
// `claimResult` is what the owner-claim `update()...returning()` resolves to;
// `inserts` captures member rows the link hook writes.
let selectResults: unknown[][] = [];
let claimResult: unknown[] = [];
let inserts: unknown[] = [];

// The gate's defense-in-depth self-heal dynamically imports customer.ts and
// calls ensureImplicitCustomer() ONLY when the implicit customer row is absent
// (a never-seeded DB). Stub it so the seed is observable and doesn't pull
// customer.ts's real transaction/insert graph; a test that wants the retry to
// succeed has the stub flip `claimResult` to a winning row.
const { ensureImplicitCustomerMock } = vi.hoisted(() => ({
  ensureImplicitCustomerMock: vi.fn(async () => {}),
}));
vi.mock("../src/lib/customer.ts", () => ({
  ensureImplicitCustomer: ensureImplicitCustomerMock,
}));

vi.mock("@midplane-cloud/db", async () => {
  const real =
    await vi.importActual<typeof import("@midplane-cloud/db")>(
      "@midplane-cloud/db",
    );
  return {
    ...real,
    getDb: () => ({
      select: () => {
        const result = selectResults.shift() ?? [];
        // The terminal differs by call site: the gate awaits `.where()`
        // directly; the member-existence check ends in `.limit()`. Make the
        // returned node both awaitable (thenable) and `.limit()`-able.
        const node = {
          limit: async () => result,
          then: (resolve: (v: unknown) => void) => resolve(result),
        };
        return { from: () => ({ where: () => node }) };
      },
      update: () => ({
        set: () => ({
          where: () => ({ returning: async () => claimResult }),
        }),
      }),
      insert: () => ({
        values: async (v: unknown) => {
          inserts.push(v);
        },
      }),
    }),
  };
});

const prevSelfHost = process.env.MIDPLANE_SELF_HOST;

beforeEach(() => {
  process.env.MIDPLANE_SELF_HOST = "1";
  selectResults = [];
  claimResult = [];
  inserts = [];
  ensureImplicitCustomerMock.mockReset();
  ensureImplicitCustomerMock.mockImplementation(async () => {});
});

afterEach(() => {
  if (prevSelfHost === undefined) delete process.env.MIDPLANE_SELF_HOST;
  else process.env.MIDPLANE_SELF_HOST = prevSelfHost;
});

const future = new Date(Date.now() + 60 * 60 * 1000);
const past = new Date(Date.now() - 60 * 60 * 1000);

describe("enforceSelfHostSignupGate", () => {
  it("an invited email passes WITHOUT claiming owner", async () => {
    // Pending, unexpired invite for this email → allowed; the owner-claim
    // update must never run (claimResult left empty would reject if it did).
    selectResults = [[{ status: "pending", expiresAt: future }]];
    claimResult = [];
    const { enforceSelfHostSignupGate } = await import(
      "../src/lib/self-host-gate.ts"
    );
    await expect(
      enforceSelfHostSignupGate("invited@team.com"),
    ).resolves.toBeUndefined();
  });

  it("an uninvited second signup is rejected (owner already claimed)", async () => {
    // No invite; the atomic claim updates zero rows (owner is taken). The row is
    // PRESENT (existence probe returns it), so the self-heal must NOT reseed —
    // this is a real second-owner attempt, not an empty DB.
    selectResults = [[], [{ id: "cust" }]];
    claimResult = [];
    const { enforceSelfHostSignupGate } = await import(
      "../src/lib/self-host-gate.ts"
    );
    await expect(
      enforceSelfHostSignupGate("stranger@evil.com"),
    ).rejects.toThrow(/already has an owner/);
    expect(ensureImplicitCustomerMock).not.toHaveBeenCalled();
  });

  it("an expired or already-used invite does NOT open the gate", async () => {
    // Candidates exist but none is pending+unexpired → falls through to the
    // claim, which (owner taken, row present) rejects without reseeding.
    selectResults = [
      [
        { status: "accepted", expiresAt: past },
        { status: "pending", expiresAt: past },
      ],
      [{ id: "cust" }],
    ];
    claimResult = [];
    const { enforceSelfHostSignupGate } = await import(
      "../src/lib/self-host-gate.ts"
    );
    await expect(
      enforceSelfHostSignupGate("expired@team.com"),
    ).rejects.toThrow(/already has an owner/);
    expect(ensureImplicitCustomerMock).not.toHaveBeenCalled();
  });

  it("self-heals a never-seeded row: seeds once, then the first signup claims owner", async () => {
    // The P0: instrumentation never seeded the implicit customer, so the first
    // claim finds no row and the existence probe comes back EMPTY. The gate must
    // seed (ensureImplicitCustomer) and retry the claim — turning a bricked
    // instance into "first request seeds" — rather than 403 on an empty DB.
    selectResults = [[], []]; // no invite; existence probe → absent
    claimResult = []; // first claim: zero rows (row missing)
    // The seed makes the row exist + unclaimed, so the retry claim wins.
    ensureImplicitCustomerMock.mockImplementation(async () => {
      claimResult = [{ ownerEmail: "founder@team.com" }];
    });
    const { enforceSelfHostSignupGate } = await import(
      "../src/lib/self-host-gate.ts"
    );
    await expect(
      enforceSelfHostSignupGate("founder@team.com"),
    ).resolves.toBeUndefined();
    expect(ensureImplicitCustomerMock).toHaveBeenCalledTimes(1);
  });

  it("the first signup still becomes owner (claim succeeds)", async () => {
    selectResults = [[]];
    claimResult = [{ ownerEmail: "founder@team.com" }];
    const { enforceSelfHostSignupGate } = await import(
      "../src/lib/self-host-gate.ts"
    );
    await expect(
      enforceSelfHostSignupGate("founder@team.com"),
    ).resolves.toBeUndefined();
  });

  it("no-op (and no DB touch) in the cloud", async () => {
    delete process.env.MIDPLANE_SELF_HOST;
    const { enforceSelfHostSignupGate } = await import(
      "../src/lib/self-host-gate.ts"
    );
    await expect(
      enforceSelfHostSignupGate("anyone@cloud.com"),
    ).resolves.toBeUndefined();
  });
});

describe("linkSelfHostOwnerMember", () => {
  it("links the OWNER as an owner member (the claimed email)", async () => {
    // 1st select: claimed owner_email; 2nd select: no existing member row.
    selectResults = [[{ ownerEmail: "founder@team.com" }], []];
    const { linkSelfHostOwnerMember } = await import(
      "../src/lib/self-host-gate.ts"
    );
    await linkSelfHostOwnerMember({ id: "u_owner", email: "founder@team.com" });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ userId: "u_owner", role: "owner" });
  });

  it("does NOT link an invited teammate (email ≠ claimed owner)", async () => {
    // Only the owner-email select runs; the email doesn't match → returns
    // before touching membership. acceptInvitation owns the teammate's row.
    selectResults = [[{ ownerEmail: "founder@team.com" }]];
    const { linkSelfHostOwnerMember } = await import(
      "../src/lib/self-host-gate.ts"
    );
    await linkSelfHostOwnerMember({
      id: "u_mate",
      email: "teammate@team.com",
    });
    expect(inserts).toHaveLength(0);
  });

  it("is idempotent for the owner (member row already exists)", async () => {
    selectResults = [[{ ownerEmail: "founder@team.com" }], [{ id: "m_1" }]];
    const { linkSelfHostOwnerMember } = await import(
      "../src/lib/self-host-gate.ts"
    );
    await linkSelfHostOwnerMember({ id: "u_owner", email: "founder@team.com" });
    expect(inserts).toHaveLength(0);
  });
});

describe("resolveSelfHostAccess", () => {
  it("grants access to an accepted member", async () => {
    const { resolveSelfHostAccess } = await import(
      "../src/lib/self-host-gate.ts"
    );
    expect(
      resolveSelfHostAccess({
        isMember: true,
        sessionEmail: "mate@team.com",
        ownerEmail: "founder@team.com",
      }),
    ).toBe(true);
  });

  it("grants access to the claimed owner even without a member row", async () => {
    const { resolveSelfHostAccess } = await import(
      "../src/lib/self-host-gate.ts"
    );
    expect(
      resolveSelfHostAccess({
        isMember: false,
        sessionEmail: "Founder@Team.com",
        ownerEmail: "founder@team.com",
      }),
    ).toBe(true);
  });

  it("DENIES a bare session that is neither a member nor the owner", async () => {
    // The crux: signed up via a pending invite, but hasn't accepted (or it was
    // revoked) → no member row, not the owner → no tenant access.
    const { resolveSelfHostAccess } = await import(
      "../src/lib/self-host-gate.ts"
    );
    expect(
      resolveSelfHostAccess({
        isMember: false,
        sessionEmail: "invited@team.com",
        ownerEmail: "founder@team.com",
      }),
    ).toBe(false);
  });

  it("denies when there is no owner_email or no session email", async () => {
    const { resolveSelfHostAccess } = await import(
      "../src/lib/self-host-gate.ts"
    );
    expect(
      resolveSelfHostAccess({
        isMember: false,
        sessionEmail: "invited@team.com",
        ownerEmail: null,
      }),
    ).toBe(false);
    expect(
      resolveSelfHostAccess({
        isMember: false,
        sessionEmail: null,
        ownerEmail: "founder@team.com",
      }),
    ).toBe(false);
  });
});

describe("selfHostNonMemberRedirect", () => {
  it("sends a non-member with a pending invite to its accept page", async () => {
    selectResults = [[{ id: "inv_1", status: "pending", expiresAt: future }]];
    const { selfHostNonMemberRedirect } = await import(
      "../src/lib/self-host-gate.ts"
    );
    expect(await selfHostNonMemberRedirect("invited@team.com")).toBe(
      "/accept-invitation/inv_1",
    );
  });

  it("sends a non-member with only expired/used invites to sign-in", async () => {
    selectResults = [[{ id: "inv_2", status: "accepted", expiresAt: past }]];
    const { selfHostNonMemberRedirect } = await import(
      "../src/lib/self-host-gate.ts"
    );
    expect(await selfHostNonMemberRedirect("ghost@team.com")).toBe("/sign-in");
  });

  it("sends an emailless session to sign-in without a DB read", async () => {
    const { selfHostNonMemberRedirect } = await import(
      "../src/lib/self-host-gate.ts"
    );
    expect(await selfHostNonMemberRedirect(null)).toBe("/sign-in");
  });
});
