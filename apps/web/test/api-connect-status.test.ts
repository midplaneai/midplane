// Route wiring for GET /api/projects/:id/connect-status — the Connect pane's
// live-confirmation poll. Mocks the session + the status lib (both covered by
// their own tests) and pins the HTTP contract: 401 signed-out, 404 on the
// foreign-project null (leakage shape), 200 + no-store with the serialized
// status. Same vi.mock route-test pattern as api-ping-routes.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

const currentCustomer = vi.fn();
const getConnectStatus = vi.fn();

vi.mock("@/lib/customer", () => ({
  currentCustomer: (...args: unknown[]) => currentCustomer(...args),
}));

vi.mock("@/lib/connect-status", async () => {
  const real = await vi.importActual<
    typeof import("../src/lib/connect-status.ts")
  >("../src/lib/connect-status.ts");
  return {
    ...real,
    getConnectStatus: (...args: unknown[]) => getConnectStatus(...args),
  };
});

const CUSTOMER = { id: "01HZZZZZZZZZZZZZZZZZZZZZZZ", region: "eu" };

function request(id = "conn-1") {
  return [
    new Request(`http://test/api/projects/${id}/connect-status`),
    { params: Promise.resolve({ id }) },
  ] as const;
}

async function loadRoute() {
  return import(
    "../src/app/api/projects/[id]/connect-status/route.ts"
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/projects/[id]/connect-status", () => {
  it("401 when not signed in", async () => {
    currentCustomer.mockResolvedValue(null);
    const { GET } = await loadRoute();
    const res = await GET(...request());
    expect(res.status).toBe(401);
    expect(getConnectStatus).not.toHaveBeenCalled();
  });

  it("404 when the project is unknown or foreign (lib returns null)", async () => {
    currentCustomer.mockResolvedValue(CUSTOMER);
    getConnectStatus.mockResolvedValue(null);
    const { GET } = await loadRoute();
    const res = await GET(...request("conn-foreign"));
    expect(res.status).toBe(404);
    expect(getConnectStatus).toHaveBeenCalledWith(CUSTOMER, "conn-foreign");
  });

  it("200 + no-store with the serialized status", async () => {
    currentCustomer.mockResolvedValue(CUSTOMER);
    getConnectStatus.mockResolvedValue({
      phase: "first_query",
      grantedDatabases: 1,
      firstQuery: {
        decision: "deny",
        at: new Date("2026-07-17T10:00:00Z"),
      },
    });
    const { GET } = await loadRoute();
    const res = await GET(...request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      phase: "first_query",
      grantedDatabases: 1,
      firstQuery: { decision: "deny", at: "2026-07-17T10:00:00.000Z" },
    });
  });
});
