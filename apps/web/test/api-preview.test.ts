// POST /api/projects/[id]/preview — auth, read-only floor, outcome mapping.
//
// The masked preview EXECUTES a real query, so the gate ordering matters: a
// member must be refused BEFORE any credential decrypt or spawn. Beyond auth,
// this pins the read-only floor (no writes reach the engine), the 404 leakage
// shape for a foreign DB, and the mapping of ctx.preview outcomes to the wire
// (allowed rows / structured rejection / 503).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetRateLimits } from "../src/lib/rate-limit.ts";

const PROJECT = { id: "conn-1", region: "eu" as const, customerId: "cust-1" };
const customer = { id: "cust-1", region: "eu" as const };

const DB = {
  id: "cdb-main",
  name: "main",
  tableAccess: { default: "read", tables: {} },
  tenantScope: null,
  guardrails: null,
  columnMasks: {},
};

let currentCustomerMock = vi.fn(async () => customer as typeof customer | null);
let requireManagerRestMock = vi.fn(
  async () => ({ userId: "u1", orgId: "o1", role: "owner" }) as unknown,
);
let getProjectMock = vi.fn(async () => ({
  project: PROJECT,
  databases: [DB],
}) as unknown);
let resolveMock = vi.fn(async () => ({ ok: true, plaintext: "postgres://decrypted" }));
let previewMock = vi.fn(async () => ({
  ok: true,
  kind: "rows",
  rows: [{ email: "***" }],
  rowCount: 1,
  truncated: false,
  auditId: "aud1",
}) as unknown);

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
  get getProjectWithDatabasesAndCredentials() {
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
    get preview() {
      return previewMock;
    },
  }),
}));

beforeEach(() => {
  resetRateLimits();
  currentCustomerMock = vi.fn(async () => customer);
  requireManagerRestMock = vi.fn(async () => ({ userId: "u1", orgId: "o1", role: "owner" }));
  getProjectMock = vi.fn(async () => ({ project: PROJECT, databases: [DB] }));
  resolveMock = vi.fn(async () => ({ ok: true, plaintext: "postgres://decrypted" }));
  previewMock = vi.fn(async () => ({
    ok: true,
    kind: "rows",
    rows: [{ email: "***" }],
    rowCount: 1,
    truncated: false,
    auditId: "aud1",
  }));
});
afterEach(() => vi.clearAllMocks());

async function loadRoute() {
  return await import("../src/app/api/projects/[id]/preview/route.ts");
}
const params = { params: Promise.resolve({ id: PROJECT.id }) };
function post(body: unknown) {
  return new Request("https://midplane.test/api/projects/conn-1/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/projects/[id]/preview", () => {
  it("401 when not signed in", async () => {
    currentCustomerMock = vi.fn(async () => null);
    const { POST } = await loadRoute();
    expect((await POST(post({ database: "main", sql: "select 1" }), params)).status).toBe(401);
  });

  it("403 for a member, BEFORE any decrypt or spawn", async () => {
    requireManagerRestMock = vi.fn(async () =>
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    const { POST } = await loadRoute();
    const res = await POST(post({ database: "main", sql: "select email from users" }), params);
    expect(res.status).toBe(403);
    expect(getProjectMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("400 on a non-SELECT statement, before spawn", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ database: "main", sql: "delete from users" }), params);
    expect(res.status).toBe(400);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("400 on an invalid body", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ database: "main" }), params);
    expect(res.status).toBe(400);
  });

  it("404 when the database is not on the project", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ database: "ghost", sql: "select 1" }), params);
    expect(res.status).toBe(404);
    expect(previewMock).not.toHaveBeenCalled();
  });

  it("200 + masked rows on an allowed preview", async () => {
    const { POST } = await loadRoute();
    const res = await POST(post({ database: "main", sql: "select email from users" }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ allowed: true, rows: [{ email: "***" }], rowCount: 1 });
    // The preview is stamped with a console intent so audit reads as a console action.
    expect(previewMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "conn-1" }),
      expect.objectContaining({ database: "main", intent: expect.stringContaining("console") }),
    );
  });

  it("200 + structured rejection on a column_masking reject (rendered as state, not error)", async () => {
    previewMock = vi.fn(async () => ({
      ok: true,
      kind: "rejected",
      policyRule: "column_masking",
      reason: "query rejected: column \"email\" comes from a view; query the base table",
      auditId: "aud2",
    }));
    const { POST } = await loadRoute();
    const res = await POST(
      post({ database: "main", sql: "select email from users_v" }),
      params,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ allowed: false, policyRule: "column_masking" });
    expect(body.reason).toContain("base table");
  });

  it("503 on engine_unavailable", async () => {
    previewMock = vi.fn(async () => ({ ok: false, kind: "engine_unavailable", detail: "fly capacity" }));
    const { POST } = await loadRoute();
    const res = await POST(post({ database: "main", sql: "select 1" }), params);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("engine_unavailable");
  });

  it("503 (masking misconfigured) when masks are declared but no salt master is set", async () => {
    const prev = process.env.MIDPLANE_MASK_SALT_MASTER;
    delete process.env.MIDPLANE_MASK_SALT_MASTER;
    getProjectMock = vi.fn(async () => ({
      project: PROJECT,
      databases: [{ ...DB, columnMasks: { "public.users": { email: "full-redact" } } }],
    }));
    try {
      const { POST } = await loadRoute();
      const res = await POST(post({ database: "main", sql: "select email from users" }), params);
      expect(res.status).toBe(503);
      expect(previewMock).not.toHaveBeenCalled();
    } finally {
      if (prev !== undefined) process.env.MIDPLANE_MASK_SALT_MASTER = prev;
    }
  });

  it("429 once the per-project budget is exhausted", async () => {
    const { POST } = await loadRoute();
    let last = 200;
    for (let i = 0; i < 8; i++) {
      last = (await POST(post({ database: "main", sql: "select 1" }), params)).status;
    }
    expect(last).toBe(429);
  });
});
