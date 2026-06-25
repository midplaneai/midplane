// GET /api/projects/[id]/scan — authorization.
//
// Regression for the reviewer finding: the PII exposure scan is owner/admin
// only (the UI mounts it behind canManage). A signed-in MEMBER must not reach
// it directly — and crucially must be refused BEFORE any DB credential is
// decrypted or schema is introspected.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT = { id: "conn-1", region: "eu", customerId: "cust-1" };
const customer = { id: "cust-1", region: "eu" as const };

let currentCustomerMock = vi.fn(async () => customer as typeof customer | null);
// Default: a manager passes the gate (returns an ActiveRole, not a Response).
let requireManagerRestMock = vi.fn(
  async () => ({ userId: "u1", orgId: "o1", role: "owner" }) as unknown,
);
let getProjectMock = vi.fn(async () => ({
  project: PROJECT,
  database: { id: "cdb-main", name: "main", columnMasks: {} },
}) as unknown);
let resolveMock = vi.fn(async () => ({ ok: true, plaintext: "postgres://decrypted" }));
let scanMock = vi.fn(async () => ({ columns: [], scannedColumns: 0 }));

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
  isValidDatabaseName: (n: unknown) => typeof n === "string" && /^[a-z][a-z0-9_-]*$/.test(n),
  get getProjectWithDatabaseAndCredential() {
    return getProjectMock;
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
vi.mock("@/lib/scan-pii-columns", () => ({
  get scanPiiColumns() {
    return scanMock;
  },
}));

beforeEach(() => {
  currentCustomerMock = vi.fn(async () => customer);
  requireManagerRestMock = vi.fn(async () => ({ userId: "u1", orgId: "o1", role: "owner" }));
  getProjectMock = vi.fn(async () => ({
    project: PROJECT,
    database: { id: "cdb-main", name: "main", columnMasks: {}, ignoredColumns: {} },
  }));
  resolveMock = vi.fn(async () => ({ ok: true, plaintext: "postgres://decrypted" }));
  scanMock = vi.fn(async () => ({ columns: [], scannedColumns: 0 }));
});
afterEach(() => vi.clearAllMocks());

async function loadRoute() {
  return await import("../src/app/api/projects/[id]/scan/route.ts");
}
const params = { params: Promise.resolve({ id: PROJECT.id }) };
const req = () => new Request("https://midplane.test/api/projects/conn-1/scan?db=main");

describe("GET /api/projects/[id]/scan — auth", () => {
  it("401 when not signed in", async () => {
    currentCustomerMock = vi.fn(async () => null);
    const { GET } = await loadRoute();
    expect((await GET(req(), params)).status).toBe(401);
  });

  it("403 for a member, BEFORE any credential decryption or introspection", async () => {
    // requireManagerRest refuses a member with a 403 Response.
    requireManagerRestMock = vi.fn(async () =>
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    const { GET } = await loadRoute();
    const res = await GET(req(), params);
    expect(res.status).toBe(403);
    // The gate must fire before any sensitive work — no project lookup, no
    // credential decrypt, no schema scan.
    expect(getProjectMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(scanMock).not.toHaveBeenCalled();
  });

  it("200 for a manager (gate passes)", async () => {
    const { GET } = await loadRoute();
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(resolveMock).toHaveBeenCalled();
    // Must NOT be cacheable: the body carries mutable columnMasks/ignoredColumns
    // the user changes via separate writes; a cached replay on rescan would
    // resurrect a just-masked/dismissed column. Pin no-store against regression.
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.columns).toEqual([]);
    // The page needs the DB's masks + dismissals to render flagged-vs-masked
    // and to hide dismissed columns.
    expect(body.columnMasks).toEqual({});
    expect(body.ignoredColumns).toEqual({});
  });
});
