// Route-layer coverage for POST /api/projects/[id]/dry-run — the
// cloud half of the policy test surface (the router half, ordering and
// engine error mapping, is pinned in packages/router/test/dry-run.test.ts).
//
// Pins: auth/ownership gates, the per-project 429, request
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
import {
  MAX_GUARDRAIL_PROBES,
  PROBE_TENANT_VALUE,
} from "../src/lib/probe-matrix.ts";

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

function makeDb(name: string, tableAccess?: unknown) {
  return {
    id: `cdb-${name}`,
    projectId: CONN.id,
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

const PROBES_BODY = {
  database: "main",
  probes: [{ table: "orders", action: "select" }],
};

describe("POST /api/projects/[id]/dry-run", () => {
  it("401 when no session", async () => {
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

  it("404 for foreign project and for a database not on the project", async () => {
    const { POST } = await loadRoute();
    getConnMock = vi.fn(async () => null);
    expect((await POST(jsonRequest(PROBES_BODY), params)).status).toBe(404);

    getConnMock = vi.fn(async () => ({
      project: CONN,
      databases: [makeDb("main")],
    }));
    const unknownDb = await POST(
      jsonRequest({ ...PROBES_BODY, database: "nope" }),
      params,
    );
    expect(unknownDb.status).toBe(404);
  });

  it("429 per (customer, project) once the probe budget is spent", async () => {
    for (let i = 0; i < 6; i++) {
      checkRateLimit(dryRunKey(customer.id, CONN.id), DRY_RUN_RATE_LIMIT);
    }
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(PROBES_BODY), params);
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
      project: CONN,
      databases: [makeDb("main", { default: "everything", tables: 7 })],
    }));
    const badPolicy = await POST(jsonRequest(PROBES_BODY), params);
    expect(badPolicy.status).toBe(503);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it("builds the proxy-identical spawn (decrypted DSNs, all dbs) and the synthetic tenant", async () => {
    getConnMock = vi.fn(async () => ({
      project: CONN,
      databases: [makeDb("analytics"), makeDb("main")],
    }));
    const { POST } = await loadRoute();
    const res = await POST(jsonRequest(PROBES_BODY), params);
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
    // A row predating the guardrails column resolves to the default-ON
    // posture (mirrors the engine's omitted-section default).
    expect(spawn.databases[0]!.guardrails).toEqual({
      block_unqualified_dml: true,
      block_ddl: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.database).toBe("main");
    expect(requests[0]!.tenant_context).toEqual({ value: PROBE_TENANT_VALUE });
  });

  it("fans guardrail_sqls out as single-statement sql requests after the probe matrix", async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest({
        ...PROBES_BODY,
        guardrail_sqls: ["delete from orders", "drop table orders"],
      }),
      params,
    );
    expect(res.status).toBe(200);

    const [, requests] = dryRunMock.mock.calls[0] as unknown as [
      unknown,
      Array<{
        database: string;
        tenant_context?: { value: string };
        probes?: unknown[];
        sql?: string;
      }>,
    ];
    expect(requests).toHaveLength(3);
    expect(requests[0]!.probes).toHaveLength(1);
    expect(requests[0]!.sql).toBeUndefined();
    expect(requests[1]).toMatchObject({
      database: "main",
      sql: "delete from orders",
    });
    expect(requests[2]).toMatchObject({
      database: "main",
      sql: "drop table orders",
    });
    // Every engine call carries the synthetic tenant — guardrail
    // statements still bind the dry-run context.
    expect(
      requests.every((r) => r.tenant_context?.value === PROBE_TENANT_VALUE),
    ).toBe(true);
  });

  it("400 when guardrail_sqls is sent without probes (it rides the matrix run only)", async () => {
    const { POST } = await loadRoute();
    const res = await POST(
      jsonRequest({
        database: "main",
        sql: "select 1",
        guardrail_sqls: ["delete from orders"],
      }),
      params,
    );
    expect(res.status).toBe(400);
    expect(dryRunMock).not.toHaveBeenCalled();
  });

  it("400 when guardrail_sqls is empty or exceeds MAX_GUARDRAIL_PROBES", async () => {
    const { POST } = await loadRoute();
    // min(1): an empty array is a caller bug, not "no guardrail checks" —
    // omit the field for that.
    const empty = await POST(
      jsonRequest({ ...PROBES_BODY, guardrail_sqls: [] }),
      params,
    );
    expect(empty.status).toBe(400);
    // max(MAX_GUARDRAIL_PROBES): the ceiling is sized to the worst-case
    // buildGuardrailProbes output; anything larger is fan-out abuse.
    const over = await POST(
      jsonRequest({
        ...PROBES_BODY,
        guardrail_sqls: Array.from(
          { length: MAX_GUARDRAIL_PROBES + 1 },
          () => "drop table orders",
        ),
      }),
      params,
    );
    expect(over.status).toBe(400);
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
