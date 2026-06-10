// Route-layer coverage for POST /api/connections/[id]/dry-run — the
// cloud half of the policy test surface (the router half, ordering and
// engine error mapping, is pinned in packages/router/test/dry-run.test.ts).
//
// Pins: auth/ownership gates, the per-connection 429, request
// validation (exactly one of probes|sql), the proxy-identical spawn
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
import { PROBE_TENANT_VALUE } from "../src/lib/probe-matrix.ts";

const customer = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  clerkOrgId: "org_clerk-1",
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

function makeDb(name: string, tableAccess?: unknown) {
  return {
    id: `cdb-${name}`,
    connectionId: CONN.id,
    name,
    tableAccess: tableAccess ?? { default: "read", tables: {} },
    tenantScope: { column: null, overrides: {}, exempt: [] },
    encryptedDsn: new Uint8Array([1]),
    kmsKeyId: "key-1",
  };
}

let currentCustomerMock = vi.fn(
  async () => customer as typeof customer | null,
);
let getConnMock = vi.fn(async () => ({
  connection: CONN,
  databases: [makeDb("main")],
}) as { connection: typeof CONN; databases: ReturnType<typeof makeDb>[] } | null);
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

vi.mock("@/lib/connections", () => ({
  get getConnectionWithDatabasesAndCredentials() {
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
    connection: CONN,
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
  return await import("../src/app/api/connections/[id]/dry-run/route.ts");
}

const params = { params: Promise.resolve({ id: CONN.id }) };

function jsonRequest(body: unknown): Request {
  return new Request("https://midplane.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PROBES_BODY = {
  database: "main",
  probes: [{ table: "orders", action: "select" }],
};

describe("POST /api/connections/[id]/dry-run", () => {
  it("401 when no Clerk session", async () => {
    currentCustomerMock = vi.fn(async () => null);
    const { POST } = await loadRoute();
    expect((await POST(jsonRequest(PROBES_BODY), params)).status).toBe(401);
  });

  it("400 unless exactly one of probes|sql is present", async () => {
    const { POST } = await loadRoute();
    const both = await POST(
      jsonRequest({ ...PROBES_BODY, sql: "select 1" }),
      params,
    );
    expect(both.status).toBe(400);
    const neither = await POST(jsonRequest({ database: "main" }), params);
    expect(neither.status).toBe(400);
    const badAction = await POST(
      jsonRequest({
        database: "main",
        probes: [{ table: "orders", action: "truncate" }],
      }),
      params,
    );
    expect(badAction.status).toBe(400);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it("404 for foreign connection and for a database not on the connection", async () => {
    const { POST } = await loadRoute();
    getConnMock = vi.fn(async () => null);
    expect((await POST(jsonRequest(PROBES_BODY), params)).status).toBe(404);

    getConnMock = vi.fn(async () => ({
      connection: CONN,
      databases: [makeDb("main")],
    }));
    const unknownDb = await POST(
      jsonRequest({ ...PROBES_BODY, database: "nope" }),
      params,
    );
    expect(unknownDb.status).toBe(404);
  });

  it("429 per (customer, connection) once the probe budget is spent", async () => {
    for (let i = 0; i < 6; i++) {
      checkRateLimit(dryRunKey(customer.id, CONN.id), DRY_RUN_RATE_LIMIT);
    }
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(PROBES_BODY), params);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it("a foreign tenant probing this connection id burns their OWN budget, not the owner's", async () => {
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
    const res = await POST(jsonRequest(PROBES_BODY), params);
    expect(res.status).toBe(200);
  });

  it("503 when a credential can't be decrypted or stored policy is malformed", async () => {
    const { POST } = await loadRoute();
    resolveMock = vi.fn(async () => ({ ok: false }));
    const cred = await POST(jsonRequest(PROBES_BODY), params);
    expect(cred.status).toBe(503);
    expect(await cred.json()).toMatchObject({ error: "engine_unavailable" });

    resolveMock = vi.fn(async () => ({ ok: true, plaintext: "postgres://x" }));
    getConnMock = vi.fn(async () => ({
      connection: CONN,
      databases: [makeDb("main", { default: "everything", tables: 7 })],
    }));
    const badPolicy = await POST(jsonRequest(PROBES_BODY), params);
    expect(badPolicy.status).toBe(503);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it("builds the proxy-identical spawn (decrypted DSNs, all dbs) and the synthetic tenant", async () => {
    getConnMock = vi.fn(async () => ({
      connection: CONN,
      databases: [makeDb("analytics"), makeDb("main")],
    }));
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(PROBES_BODY), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verdicts: [], truncated: false });

    const [spawn, request] = dryRunMock.mock.calls[0] as unknown as [
      {
        connectionId: string;
        region: string;
        databases: Array<{ name: string; dsn: string }>;
      },
      { database: string; tenant_context?: { value: string } },
    ];
    expect(spawn.connectionId).toBe(CONN.id);
    expect(spawn.databases.map((d) => d.name)).toEqual(["analytics", "main"]);
    expect(spawn.databases.every((d) => d.dsn === "postgres://decrypted")).toBe(
      true,
    );
    expect(request.database).toBe("main");
    expect(request.tenant_context).toEqual({ value: PROBE_TENANT_VALUE });
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
    const res = await POST(jsonRequest(PROBES_BODY), params);
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
    const res = await POST(jsonRequest(PROBES_BODY), params);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe("engine_unavailable");
    expect(body.detail).toBeUndefined();
  });
});
