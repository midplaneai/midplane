// Route-layer coverage for GET /api/projects/[id]/tables — the
// per-db rewrite (REGRESSION: was main-db-only; the permission grid's
// autocomplete used to introspect the wrong database on non-main db
// pages). Pins: the ?db= default ("main", back-compat), the 404
// leakage shape for invalid/unknown names, the soft-error convention
// ({tables:[], error} at HTTP 200 — the dashboard renders an inline
// hint, never a dead dropdown), and the private cache header.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const customer = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  orgId: "org_clerk-1",
  email: "u@e.test",
  region: "eu" as const,
  createdAt: new Date(),
};

const CONN = { id: "conn-1", customerId: customer.id, region: "eu" as const };

let currentCustomerMock = vi.fn(async () => customer as typeof customer | null);
// Default: a manager passes the gate (an ActiveRole, not a Response).
let requireManagerRestMock = vi.fn(
  async () => ({ userId: "u1", orgId: "o1", role: "owner" }) as unknown,
);
let getConnDbMock = vi.fn(async (_c: unknown, _id: string, name: string) =>
  ({
    project: CONN,
    database: { id: `cdb-${name}`, name, encryptedDsn: new Uint8Array([1]) },
  }) as { project: typeof CONN; database: { id: string; name: string } } | null,
);
let resolveMock = vi.fn(async () => ({
  ok: true,
  plaintext: "postgres://decrypted",
}) as { ok: boolean; plaintext?: string });
let listTablesMock = vi.fn(async () => ({ tables: ["orders", "users"] }));

vi.mock("@/lib/customer", () => ({
  get currentCustomer() {
    return currentCustomerMock;
  },
}));

vi.mock("@/lib/org-auth", () => ({
  get requireManagerRest() {
    return requireManagerRestMock;
  },
}));

vi.mock("@/lib/projects", () => ({
  DEFAULT_DATABASE_NAME: "main",
  isValidDatabaseName: (s: unknown) =>
    typeof s === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(s),
  get getProjectWithDatabaseAndCredential() {
    return getConnDbMock;
  },
}));

vi.mock("@/lib/mcp-proxy", () => ({
  getMcpProxyContext: () => ({
    resolver: {
      get resolve() {
        return resolveMock;
      },
    },
  }),
}));

vi.mock("@/lib/list-tables", () => ({
  get listTables() {
    return listTablesMock;
  },
}));

beforeEach(() => {
  currentCustomerMock = vi.fn(async () => customer);
  requireManagerRestMock = vi.fn(async () => ({ userId: "u1", orgId: "o1", role: "owner" }));
  getConnDbMock = vi.fn(async (_c, _id, name: string) => ({
    project: CONN,
    database: { id: `cdb-${name}`, name, encryptedDsn: new Uint8Array([1]) },
  }));
  resolveMock = vi.fn(async () => ({ ok: true, plaintext: "postgres://decrypted" }));
  listTablesMock = vi.fn(async () => ({ tables: ["orders", "users"] }));
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadRoute() {
  return await import("../src/app/api/projects/[id]/tables/route.ts");
}

const params = { params: Promise.resolve({ id: CONN.id }) };

function get(query: string): Request {
  return new Request(`https://midplane.test/api/projects/conn-1/tables${query}`);
}

describe("GET /api/projects/[id]/tables (per-db)", () => {
  it("401 when no session", async () => {
    currentCustomerMock = vi.fn(async () => null);
    const { GET } = await loadRoute();
    expect((await GET(get("?q=ord"), params)).status).toBe(401);
  });

  it("403 for a member, before any credential decryption or introspection", async () => {
    requireManagerRestMock = vi.fn(async () =>
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    const { GET } = await loadRoute();
    const res = await GET(get("?q=ord"), params);
    expect(res.status).toBe(403);
    expect(getConnDbMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(listTablesMock).not.toHaveBeenCalled();
  });

  it("defaults to the main database (back-compat for pre-?db= callers)", async () => {
    const { GET } = await loadRoute();
    const res = await GET(get("?q=ord"), params);
    expect(res.status).toBe(200);
    expect(getConnDbMock).toHaveBeenCalledWith(customer, CONN.id, "main");
    expect(await res.json()).toEqual({ tables: ["orders", "users"] });
    expect(res.headers.get("cache-control")).toBe("private, max-age=10");
  });

  it("introspects the NAMED database when ?db= is given", async () => {
    const { GET } = await loadRoute();
    const res = await GET(get("?q=&db=analytics"), params);
    expect(res.status).toBe(200);
    expect(getConnDbMock).toHaveBeenCalledWith(customer, CONN.id, "analytics");
  });

  it("404s invalid and unknown db names with the standard leakage shape", async () => {
    const { GET } = await loadRoute();
    const invalid = await GET(get("?db=Robert');%20DROP"), params);
    expect(invalid.status).toBe(404);
    expect(getConnDbMock).not.toHaveBeenCalled();

    getConnDbMock = vi.fn(async () => null);
    const unknown = await GET(get("?db=nope"), params);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "not found" });
  });

  it("soft-fails at HTTP 200: credential_unavailable and introspection_failed", async () => {
    const { GET } = await loadRoute();
    resolveMock = vi.fn(async () => ({ ok: false }));
    const cred = await GET(get("?q="), params);
    expect(cred.status).toBe(200);
    expect(await cred.json()).toEqual({
      tables: [],
      error: "credential_unavailable",
    });

    resolveMock = vi.fn(async () => ({ ok: true, plaintext: "postgres://x" }));
    listTablesMock = vi.fn(async () => {
      throw new Error("timeout");
    });
    const intro = await GET(get("?q="), params);
    expect(intro.status).toBe(200);
    expect(await intro.json()).toMatchObject({
      tables: [],
      error: "introspection_failed",
    });
  });
});
