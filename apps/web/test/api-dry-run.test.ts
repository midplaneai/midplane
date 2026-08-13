// Route-layer coverage for POST /api/projects/[id]/dry-run — the
// cloud half of the policy test surface (the router half, ordering and
// engine error mapping, is pinned in packages/router/test/dry-run.test.ts).
//
// Pins: auth/ownership gates, the per-project 429, request
// validation, the proxy-identical spawn
// construction (decrypted DSNs, synthetic tenant), and the
// outcome → HTTP status map (ok→200, engine_rejected→400 verbatim,
// engine_unavailable→503 retryable).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkRateLimit,
  DRY_RUN_RATE_LIMIT,
  dryRunKey,
  resetRateLimits,
} from "../src/lib/rate-limit.ts";

const customer = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  orgId: "org_clerk-1",
  email: "u@e.test",
  region: "eu" as const,
  createdAt: new Date(),
};

const CONN = {
  id: "conn-1",
  customerId: customer.id,
  region: "eu" as const,
  name: "acme-prod",
};

function makeDb(name: string, tableAccess?: unknown, columnMasks: unknown = {}) {
  return {
    id: `cdb-${name}`,
    projectId: CONN.id,
    name,
    tableAccess: tableAccess ?? { default: "read", tables: {} },
    tenantScope: { column: null, overrides: {}, exempt: [] },
    columnMasks,
    encryptedDsn: new Uint8Array([1]),
    kmsKeyId: "key-1",
  };
}

let currentCustomerMock = vi.fn(
  async () => customer as typeof customer | null,
);
let getConnMock = vi.fn(async () => ({
  project: CONN,
  databases: [makeDb("main")],
}) as { project: typeof CONN; databases: ReturnType<typeof makeDb>[] } | null);
let resolveMock = vi.fn(async () => ({
  ok: true,
  plaintext: "postgres://decrypted",
}) as { ok: boolean; plaintext?: string });
let dryRunMock = vi.fn(async () => ({
  ok: true,
  response: { verdicts: [], truncated: false },
}) as unknown);

vi.mock("@/lib/customer", () => ({
  get currentCustomer() {
    return currentCustomerMock;
  },
}));

vi.mock("@/lib/projects", () => ({
  get getProjectWithDatabasesAndCredentials() {
    return getConnMock;
  },
}));

vi.mock("@/lib/mcp-proxy", () => ({
  getMcpProxyContext: () => ({
    resolver: {
      get resolve() {
        return resolveMock;
      },
    },
    get dryRun() {
      return dryRunMock;
    },
  }),
}));

beforeEach(() => {
  resetRateLimits();
  currentCustomerMock = vi.fn(async () => customer);
  getConnMock = vi.fn(async () => ({
    project: CONN,
    databases: [makeDb("main")],
  }));
  resolveMock = vi.fn(async () => ({ ok: true, plaintext: "postgres://decrypted" }));
  dryRunMock = vi.fn(async () => ({
    ok: true,
    response: { verdicts: [], truncated: false },
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadRoute() {
  return await import("../src/app/api/projects/[id]/dry-run/route.ts");
}

const params = { params: Promise.resolve({ id: CONN.id }) };

function jsonRequest(body: unknown): Request {
  return new Request("https://midplane.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The engine also accepts a structured probe matrix; the cloud stopped
// sending one, so `sql` is the whole request surface now.
const PROBE_TENANT_VALUE = "__midplane_probe__";

const SQL_BODY = { database: "main", sql: "select 1 from orders" };

describe("POST /api/projects/[id]/dry-run", () => {
  it("401 when no session", async () => {
    currentCustomerMock = vi.fn(async () => null);
    const { POST } = await loadRoute();
    expect((await POST(jsonRequest(SQL_BODY), params)).status).toBe(401);
  });

  it("400 on a body without a statement", async () => {
    const { POST } = await loadRoute();
    const neither = await POST(jsonRequest({ database: "main" }), params);
    expect(neither.status).toBe(400);
    const empty = await POST(
      jsonRequest({ database: "main", sql: "" }),
      params,
    );
    expect(empty.status).toBe(400);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it("404 for foreign project and for a database not on the project", async () => {
    const { POST } = await loadRoute();
    getConnMock = vi.fn(async () => null);
    expect((await POST(jsonRequest(SQL_BODY), params)).status).toBe(404);

    getConnMock = vi.fn(async () => ({
      project: CONN,
      databases: [makeDb("main")],
    }));
    const unknownDb = await POST(
      jsonRequest({ ...SQL_BODY, database: "nope" }),
      params,
    );
    expect(unknownDb.status).toBe(404);
  });

  it("429 per (customer, project) once the probe budget is spent", async () => {
    for (let i = 0; i < 6; i++) {
      checkRateLimit(dryRunKey(customer.id, CONN.id), DRY_RUN_RATE_LIMIT);
    }
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(SQL_BODY), params);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it("a foreign tenant probing this project id burns their OWN budget, not the owner's", async () => {
    // Review finding: keying on the bare path param let any signed-in
    // tenant starve the owner. Burn 6 slots as a DIFFERENT customer —
    // the route must still serve the owner.
    for (let i = 0; i < 6; i++) {
      checkRateLimit(
        dryRunKey("01HATTACKERXXXXXXXXXXXXXXX", CONN.id),
        DRY_RUN_RATE_LIMIT,
      );
    }
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(SQL_BODY), params);
    expect(res.status).toBe(200);
  });

  it("503 when a credential can't be decrypted or stored policy is malformed", async () => {
    const { POST } = await loadRoute();
    resolveMock = vi.fn(async () => ({ ok: false }));
    const cred = await POST(jsonRequest(SQL_BODY), params);
    expect(cred.status).toBe(503);
    expect(await cred.json()).toMatchObject({ error: "engine_unavailable" });

    resolveMock = vi.fn(async () => ({ ok: true, plaintext: "postgres://x" }));
    getConnMock = vi.fn(async () => ({
      project: CONN,
      databases: [makeDb("main", { default: "everything", tables: 7 })],
    }));
    const badPolicy = await POST(jsonRequest(SQL_BODY), params);
    expect(badPolicy.status).toBe(503);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it("builds the proxy-identical spawn (decrypted DSNs, all dbs) and the synthetic tenant", async () => {
    getConnMock = vi.fn(async () => ({
      project: CONN,
      databases: [makeDb("analytics"), makeDb("main")],
    }));
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(SQL_BODY), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdicts: [], truncated: false });

    const [spawn, requests] = dryRunMock.mock.calls[0] as unknown as [
      {
        projectId: string;
        region: string;
        databases: Array<{ name: string; dsn: string; guardrails?: unknown }>;
      },
      Array<{ database: string; tenant_context?: { value: string } }>,
    ];
    expect(spawn.projectId).toBe(CONN.id);
    expect(spawn.databases.map((d) => d.name)).toEqual(["analytics", "main"]);
    expect(spawn.databases.every((d) => d.dsn === "postgres://decrypted")).toBe(
      true,
    );
    // A row predating the guardrails column resolves to the default posture
    // (mirrors the engine's omitted-section default): the destructive classes
    // refused, row changes allowed.
    expect(spawn.databases[0]!.guardrails).toEqual({
      block_unqualified_dml: true,
      block_ddl: true,
      block_dml: false,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.database).toBe("main");
    expect(requests[0]!.tenant_context).toEqual({ value: PROBE_TENANT_VALUE });
  });

  it("carries column_masks + a derived mask salt into the spawn (warm pool stays consistent with proxy/preview)", async () => {
    const prevMaster = process.env.MIDPLANE_MASK_SALT_MASTER;
    process.env.MIDPLANE_MASK_SALT_MASTER = "m".repeat(40);
    try {
      getConnMock = vi.fn(async () => ({
        project: CONN,
        databases: [makeDb("main", undefined, { "public.users": { email: "full-redact" } })],
      }));
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(SQL_BODY), params);
      expect(res.status).toBe(200);
      const [spawn] = dryRunMock.mock.calls[0] as unknown as [
        { databases: Array<{ columnMasks?: unknown }>; maskSalt?: string },
      ];
      expect(spawn.databases[0]!.columnMasks).toEqual({
        "public.users": { email: "full-redact" },
      });
      expect(typeof spawn.maskSalt).toBe("string");
      expect(spawn.maskSalt!.length).toBeGreaterThan(0);
    } finally {
      if (prevMaster === undefined) delete process.env.MIDPLANE_MASK_SALT_MASTER;
      else process.env.MIDPLANE_MASK_SALT_MASTER = prevMaster;
    }
  });

  it("503 when a db declares column_masks but MIDPLANE_MASK_SALT_MASTER is unset — never boots a mask-less container", async () => {
    const prevMaster = process.env.MIDPLANE_MASK_SALT_MASTER;
    delete process.env.MIDPLANE_MASK_SALT_MASTER;
    try {
      getConnMock = vi.fn(async () => ({
        project: CONN,
        databases: [makeDb("main", undefined, { "public.users": { email: "full-redact" } })],
      }));
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(SQL_BODY), params);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ detail: "masking misconfigured" });
      expect(dryRunMock).not.toHaveBeenCalled();
    } finally {
      if (prevMaster === undefined) delete process.env.MIDPLANE_MASK_SALT_MASTER;
      else process.env.MIDPLANE_MASK_SALT_MASTER = prevMaster;
    }
  });

  it("sends exactly one engine request, carrying the statement and the synthetic tenant", async () => {
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(SQL_BODY), params);
    expect(res.status).toBe(200);

    const [, requests] = dryRunMock.mock.calls[0] as unknown as [
      unknown,
      Array<{
        database: string;
        tenant_context?: { value: string };
        sql?: string;
      }>,
    ];
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      database: "main",
      sql: "select 1 from orders",
      tenant_context: { value: PROBE_TENANT_VALUE },
    });
  });

  it("400 on a statement past the length ceiling", async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest({ database: "main", sql: "s".repeat(10_001) }),
      params,
    );
    expect(res.status).toBe(400);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it("maps engine_rejected → 400 with the engine body verbatim", async () => {
    dryRunMock = vi.fn(async () => ({
      ok: false,
      kind: "engine_rejected",
      status: 400,
      body: '{"error":"unparseable sql"}',
    }));
    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest({ database: "main", sql: "SELEKT" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "engine_rejected",
      detail: '{"error":"unparseable sql"}',
    });
  });

  it("maps engine_unavailable → 503 (retryable) with the detail", async () => {
    dryRunMock = vi.fn(async () => ({
      ok: false,
      kind: "engine_unavailable",
      detail: "engine timed out",
    }));
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(SQL_BODY), params);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "engine_unavailable",
      detail: "engine timed out",
    });
  });

  it("collapses internal spawn error text to a bare 503 (no infra leak)", async () => {
    dryRunMock = vi.fn(async () => ({
      ok: false,
      kind: "engine_unavailable",
      detail: "Fly Machines API 422: capacity exhausted in fra region",
    }));
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(SQL_BODY), params);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe("engine_unavailable");
    expect(body.detail).toBeUndefined();
  });
});
