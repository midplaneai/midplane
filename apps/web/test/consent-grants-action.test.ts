import { beforeEach, describe, expect, it, vi } from "vitest";

// writeConsentGrants — the server action behind the consent picker's Allow.
//
// The behaviour under test is the ordering fix: grants are replace-all, so the
// action must refuse to touch them unless THIS page's authorization request is
// still pending. Before the gate, a parked consent tab could rewrite a live
// agent's grant set (and re-run the attribution/rebind path) even though its own
// consent POST then 401'd on the consumed code.

const currentCustomerMock = vi.fn();
const getOrgContextMock = vi.fn();
const setOAuthGrantsMock = vi.fn();
const ensureAttributionMock = vi.fn();
const verificationRowsMock = vi.fn();
const clientRowsMock = vi.fn();

// getDb is used for two different reads in the action (the registered-client
// lookup, then the pending-consent lookup). Route them by which table the
// builder chain selects from, so each can be steered independently.
vi.mock("@midplane-cloud/db", () => ({
  getDb: () => ({
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () => ("value" in cols ? verificationRowsMock() : clientRowsMock()),
        }),
      }),
    }),
  }),
}));
vi.mock("@midplane-cloud/db/auth-schema", () => ({
  oauthApplication: { clientId: "client_id", disabled: "disabled" },
  verification: { identifier: "identifier", value: "value", expiresAt: "expires_at" },
}));
vi.mock("@midplane-cloud/router", () => ({ safeErrorDetail: (e: unknown) => String(e) }));
vi.mock("@/lib/customer", () => ({
  get currentCustomer() {
    return currentCustomerMock;
  },
}));
vi.mock("@/lib/org-context", () => ({
  get getOrgContext() {
    return getOrgContextMock;
  },
}));
vi.mock("@/lib/scope-grants", () => ({
  get setOAuthGrants() {
    return setOAuthGrantsMock;
  },
}));
vi.mock("@/lib/tokens", () => ({
  get ensureConsentAttributionToken() {
    return ensureAttributionMock;
  },
}));
vi.mock("@/lib/posthog", () => ({ getPostHog: () => null }));
vi.mock("@/lib/analytics", () => ({
  analyticsGroups: () => ({}),
  captureError: vi.fn(),
}));

const CODE = "consent-code-1";
const CLIENT = "client-1";
const PROJECT = "proj-1";
const SELECTIONS = [{ projectDatabaseId: "cdb-1", access: "read" as const }];

function pendingRow(overrides: Record<string, unknown> = {}) {
  return [
    {
      value: JSON.stringify({
        clientId: CLIENT,
        userId: "user-1",
        requireConsent: true,
        ...overrides,
      }),
      expiresAt: new Date(Date.now() + 60_000),
    },
  ];
}

async function call(...args: Parameters<typeof import("@/app/oauth/consent/actions").writeConsentGrants>) {
  const { writeConsentGrants } = await import("@/app/oauth/consent/actions");
  return writeConsentGrants(...args);
}

describe("writeConsentGrants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentCustomerMock.mockResolvedValue({ id: "cust-1", region: "eu" });
    getOrgContextMock.mockResolvedValue({ userId: "user-1" });
    clientRowsMock.mockResolvedValue([{ clientId: CLIENT }]);
    verificationRowsMock.mockResolvedValue(pendingRow());
    setOAuthGrantsMock.mockResolvedValue(1);
    ensureAttributionMock.mockResolvedValue(undefined);
  });

  it("writes grants for a pending request", async () => {
    const r = await call(CODE, CLIENT, PROJECT, SELECTIONS);
    expect(r).toEqual({ ok: true, granted: 1 });
    expect(setOAuthGrantsMock).toHaveBeenCalledOnce();
    expect(ensureAttributionMock).toHaveBeenCalledOnce();
  });

  // The regression: a second Allow after the first already consumed the code.
  it("refuses — and writes NOTHING — when the code was already consumed", async () => {
    verificationRowsMock.mockResolvedValue([]);
    const r = await call(CODE, CLIENT, PROJECT, SELECTIONS);
    expect(r).toEqual({ ok: false, error: "stale_request" });
    expect(setOAuthGrantsMock).not.toHaveBeenCalled();
    // Critically also not this: the rebind path can revoke a live agent.
    expect(ensureAttributionMock).not.toHaveBeenCalled();
  });

  it("refuses when the pending request belongs to another user", async () => {
    verificationRowsMock.mockResolvedValue(pendingRow({ userId: "someone-else" }));
    const r = await call(CODE, CLIENT, PROJECT, SELECTIONS);
    expect(r).toEqual({ ok: false, error: "stale_request" });
    expect(setOAuthGrantsMock).not.toHaveBeenCalled();
  });

  it("rejects a missing consent code before any lookup", async () => {
    const r = await call("", CLIENT, PROJECT, SELECTIONS);
    expect(r).toEqual({ ok: false, error: "bad_request" });
    expect(clientRowsMock).not.toHaveBeenCalled();
  });

  it("rejects an empty clientId / projectId", async () => {
    expect(await call(CODE, "", PROJECT, SELECTIONS)).toEqual({
      ok: false,
      error: "bad_request",
    });
    expect(await call(CODE, CLIENT, "", SELECTIONS)).toEqual({
      ok: false,
      error: "bad_request",
    });
  });

  it("rejects a non-array selections payload (tamper path)", async () => {
    // @ts-expect-error — exercising a tampered submit
    expect(await call(CODE, CLIENT, PROJECT, "nope")).toEqual({
      ok: false,
      error: "bad_request",
    });
  });

  it("rejects an unregistered or operator-disabled client", async () => {
    clientRowsMock.mockResolvedValue([]);
    const r = await call(CODE, CLIENT, PROJECT, SELECTIONS);
    expect(r).toEqual({ ok: false, error: "bad_request" });
    expect(verificationRowsMock).not.toHaveBeenCalled();
    expect(setOAuthGrantsMock).not.toHaveBeenCalled();
  });

  it("returns unauthenticated with no customer or no user", async () => {
    currentCustomerMock.mockResolvedValue(null);
    expect(await call(CODE, CLIENT, PROJECT, SELECTIONS)).toEqual({
      ok: false,
      error: "unauthenticated",
    });

    currentCustomerMock.mockResolvedValue({ id: "cust-1", region: "eu" });
    getOrgContextMock.mockResolvedValue({ userId: null });
    expect(await call(CODE, CLIENT, PROJECT, SELECTIONS)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
  });

  it("reports internal (not stale) when the grant write itself fails", async () => {
    setOAuthGrantsMock.mockRejectedValue(new Error("constraint violation"));
    const r = await call(CODE, CLIENT, PROJECT, SELECTIONS);
    expect(r).toEqual({ ok: false, error: "internal" });
  });

  // granted: 0 is a real consent outcome (client approved, no databases).
  it("succeeds with an empty selection", async () => {
    setOAuthGrantsMock.mockResolvedValue(0);
    const r = await call(CODE, CLIENT, PROJECT, []);
    expect(r).toEqual({ ok: true, granted: 0 });
    expect(ensureAttributionMock).toHaveBeenCalledOnce();
  });
});
