// Route-layer coverage for the two pasted-DSN ping surfaces:
//
//   POST /api/connections/test-dsn            (new — pre-create, no parent id)
//   POST /api/connections/[id]/databases/test (REGRESSION: gained the 429
//                                              branch and the pingDsn →
//                                              pingDsnGuarded swap)
//
// The guard + limiter libs are covered in ping-guard.test.ts /
// rate-limit.test.ts — these tests pin the WIRING: status codes, the
// retry-after header, the shared per-customer budget key, and that the
// route returns whatever the guarded ping says (the SSRF posture lives
// below this layer). vi.mock pattern per api-tokens.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkRateLimit, resetRateLimits } from "../src/lib/rate-limit.ts";

const customer = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  orgId: "org_clerk-1",
  email: "u@e.test",
  region: "eu" as const,
  createdAt: new Date(),
};

let currentCustomerMock = vi.fn(async () => customer as typeof customer | null);
let getOrgContextMock = vi.fn(
  async () =>
    ({ userId: "user_1", orgId: "org_1" }) as {
      userId: string | null;
      orgId: string | null;
    },
);
let pingGuardedMock = vi.fn(async () => ({ ok: true }) as {
  ok: boolean;
  error?: string;
});
/** Ownership rows returned by the fake drizzle chain in the per-conn route. */
let ownedRows: Array<{ id: string }> = [{ id: "conn-1" }];

vi.mock("@/lib/customer", () => ({
  get currentCustomer() {
    return currentCustomerMock;
  },
}));

// The routes read identity through the getOrgContext seam (Better Auth under
// the hood); mock the seam, not the provider.
vi.mock("@/lib/org-context", () => ({
  get getOrgContext() {
    return getOrgContextMock;
  },
}));

vi.mock("@/lib/ping-guard", () => ({
  get pingDsnGuarded() {
    return pingGuardedMock;
  },
}));

vi.mock("@/lib/posthog", () => ({
  getPostHog: () => null,
}));

// isValidDsn is the only @/lib/connections symbol the test-dsn route
// needs; keep the real implementation, skip the heavy module graph.
vi.mock("@/lib/connections", () => ({
  isValidDsn: (s: unknown) =>
    typeof s === "string" && /^postgres(ql)?:\/\//i.test(s) && s.length >= 8,
}));

// The per-conn route does its ownership SELECT directly via getDb —
// fake the minimal chain shape.
vi.mock("@midplane-cloud/db", async () => {
  const real =
    await vi.importActual<typeof import("@midplane-cloud/db")>(
      "@midplane-cloud/db",
    );
  return {
    ...real,
    getDb: () => ({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => ownedRows,
          }),
        }),
      }),
    }),
  };
});

beforeEach(() => {
  resetRateLimits();
  currentCustomerMock = vi.fn(async () => customer as typeof customer | null);
  getOrgContextMock = vi.fn(async () => ({ userId: "user_1", orgId: "org_1" }));
  pingGuardedMock = vi.fn(async () => ({ ok: true }));
  ownedRows = [{ id: "conn-1" }];
});

afterEach(() => {
  vi.clearAllMocks();
});

function jsonRequest(body?: unknown): Request {
  return new Request("https://midplane.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : "not json {",
  });
}

const GOOD_DSN = "postgres://u:p@db.example.com:5432/app";

async function loadTestDsnRoute() {
  return await import("../src/app/api/connections/test-dsn/route.ts");
}

async function loadPerConnRoute() {
  return await import(
    "../src/app/api/connections/[id]/databases/test/route.ts"
  );
}

describe("POST /api/connections/test-dsn", () => {
  it("401 when no Clerk session", async () => {
    currentCustomerMock = vi.fn(async () => null);
    const { POST } = await loadTestDsnRoute();
    const res = await POST(jsonRequest({ dsn: GOOD_DSN }));
    expect(res.status).toBe(401);
    expect(pingGuardedMock).not.toHaveBeenCalled();
  });

  it("400 on invalid DSN and on non-JSON body", async () => {
    const { POST } = await loadTestDsnRoute();
    expect((await POST(jsonRequest({ dsn: "mysql://nope" }))).status).toBe(400);
    expect((await POST(jsonRequest())).status).toBe(400);
    expect(pingGuardedMock).not.toHaveBeenCalled();
  });

  it("passes the guarded ping result through verbatim", async () => {
    pingGuardedMock = vi.fn(async () => ({
      ok: false,
      error: "Could not connect. Check the host, port, and that the database accepts connections from the internet.",
    }));
    const { POST } = await loadTestDsnRoute();
    const res = await POST(jsonRequest({ dsn: GOOD_DSN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false });
    expect(pingGuardedMock).toHaveBeenCalledWith(GOOD_DSN);
  });

  it("429 with retry-after once the shared per-customer budget is spent", async () => {
    // Burn the shared budget the way any sibling surface would.
    for (let i = 0; i < 10; i++) {
      checkRateLimit(`test-dsn:${customer.id}`, { limit: 10, windowMs: 60_000 });
    }
    const { POST } = await loadTestDsnRoute();
    const res = await POST(jsonRequest({ dsn: GOOD_DSN }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(pingGuardedMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/connections/[id]/databases/test (regression: guard + 429)", () => {
  const params = { params: Promise.resolve({ id: "conn-1" }) };

  it("401 / 404 gates still hold", async () => {
    const { POST } = await loadPerConnRoute();
    currentCustomerMock = vi.fn(async () => null);
    expect((await POST(jsonRequest({ dsn: GOOD_DSN }), params)).status).toBe(
      401,
    );

    currentCustomerMock = vi.fn(async () => customer);
    ownedRows = []; // foreign / unknown connection
    expect((await POST(jsonRequest({ dsn: GOOD_DSN }), params)).status).toBe(
      404,
    );
    expect(pingGuardedMock).not.toHaveBeenCalled();
  });

  it("routes through pingDsnGuarded (not the bare driver) and returns its result", async () => {
    pingGuardedMock = vi.fn(async () => ({ ok: true }));
    const { POST } = await loadPerConnRoute();
    const res = await POST(jsonRequest({ dsn: GOOD_DSN }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(pingGuardedMock).toHaveBeenCalledWith(GOOD_DSN);
  });

  it("shares the test-dsn budget — 429 after the window is spent elsewhere", async () => {
    for (let i = 0; i < 10; i++) {
      checkRateLimit(`test-dsn:${customer.id}`, { limit: 10, windowMs: 60_000 });
    }
    const { POST } = await loadPerConnRoute();
    const res = await POST(jsonRequest({ dsn: GOOD_DSN }), params);
    expect(res.status).toBe(429);
    expect(pingGuardedMock).not.toHaveBeenCalled();
  });
});
