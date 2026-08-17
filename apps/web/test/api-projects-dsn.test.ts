// The DSN gate on the two project-mutating REST surfaces:
//
//   POST  /api/projects       (create — programmatic callers)
//   PATCH /api/projects/[id]  (rotate the stored credential)
//
// Both used to reject a bad connection string with `{error: "invalid body"}`
// and the real reason buried in a zod `issues` array. These pin the contract
// the browser forms and the ping probes now share: the 400 carries a sentence
// naming the problem, plus the remedy in `hint`, and nothing downstream runs.
//
// Mock surface is deliberately thin — the gate fires before any of it is
// reached, so the stubs only have to exist. vi.mock pattern per
// api-tokens.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const customer = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  orgId: "org_clerk-1",
  email: "u@e.test",
  region: "eu" as const,
  createdAt: new Date(),
};

let currentCustomerMock = vi.fn(async () => customer as typeof customer | null);
let requireManagerRestMock = vi.fn(
  async () => ({ userId: "user_1", orgId: "org_1", role: "owner" }) as unknown,
);
const createProjectMock = vi.fn();
const rotateProjectMock = vi.fn();
const getProjectWithFirstDatabaseMock = vi.fn();

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

// @/lib/projects pulls the postgres driver + the whole project module graph.
// Neither route reaches it on the rejection path — stub the symbols they
// import so the module loads.
vi.mock("@/lib/projects", () => ({
  get createProject() {
    return createProjectMock;
  },
  get rotateProject() {
    return rotateProjectMock;
  },
  get getProjectWithFirstDatabase() {
    return getProjectWithFirstDatabaseMock;
  },
  get deleteProject() {
    return vi.fn();
  },
  isValidDatabaseName: (s: unknown) =>
    typeof s === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(s),
}));

vi.mock("@/lib/mcp-proxy", () => ({ getMcpProxyContext: () => ({}) }));
vi.mock("@/lib/posthog", () => ({ getPostHog: () => null }));
vi.mock("@/lib/plan", () => ({
  resolvePlan: async () => ({ plan: "free", caps: {} }),
  planLimitBody: () => ({ error: "limit" }),
  PlanLimitError: class PlanLimitError extends Error {},
}));

beforeEach(() => {
  currentCustomerMock = vi.fn(async () => customer as typeof customer | null);
  requireManagerRestMock = vi.fn(async () => ({
    userId: "user_1",
    orgId: "org_1",
    role: "owner",
  }));
});

afterEach(() => {
  vi.clearAllMocks();
});

function jsonRequest(body: unknown): Request {
  return new Request("https://midplane.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const GOOD_DSN = "postgres://u:p@db.example.com:5432/app";

describe("POST /api/projects — DSN gate", () => {
  it("400s a non-Postgres URL with the reason, and creates nothing", async () => {
    const { POST } = await import("../src/app/api/projects/route.ts");
    const res = await POST(jsonRequest({ dsn: "mysql://u:p@host/db" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; hint?: string };
    expect(body.error).not.toBe("invalid body");
    expect(body.error).toMatch(/mysql:\/\/ url/i);
    expect(body.hint).toMatch(/postgres:\/\//i);
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("400s an unparseable DSN the old scheme-only check waved through", async () => {
    const { POST } = await import("../src/app/api/projects/route.ts");
    // Passes /^postgres(ql)?:\/\//, fails `new URL` — it would have been
    // encrypted and stored, then failed at spawn time with no useful message.
    const res = await POST(jsonRequest({ dsn: "postgres://u:p@host:port/db" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/parse/i);
    expect(createProjectMock).not.toHaveBeenCalled();
  });

  it("passes a good DSN through, normalized", async () => {
    createProjectMock.mockResolvedValueOnce({
      id: "proj-1",
      defaultTokenPlaintext: "mp_test",
    });
    const { POST } = await import("../src/app/api/projects/route.ts");
    await POST(jsonRequest({ dsn: `  ${GOOD_DSN}\n` }));
    expect(createProjectMock).toHaveBeenCalled();
    expect(createProjectMock.mock.calls[0]?.[1]).toBe(GOOD_DSN);
  });
});

describe("PATCH /api/projects/[id] — DSN gate", () => {
  const params = { params: Promise.resolve({ id: "proj-1" }) };

  it("400s a bad DSN before the ownership lookup", async () => {
    const { PATCH } = await import("../src/app/api/projects/[id]/route.ts");
    const req = new Request("https://midplane.test/api", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dsn: "host=db.example.com dbname=app" }),
    });
    const res = await PATCH(req, params);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; hint?: string };
    expect(body.error).toMatch(/libpq keyword format/i);
    expect(body.hint).toMatch(/postgres:\/\//i);
    expect(getProjectWithFirstDatabaseMock).not.toHaveBeenCalled();
    expect(rotateProjectMock).not.toHaveBeenCalled();
  });

  it("rotates with the normalized DSN when the shape is good", async () => {
    getProjectWithFirstDatabaseMock.mockResolvedValueOnce({
      database: { name: "app" },
    });
    rotateProjectMock.mockResolvedValueOnce({ id: "proj-1" });
    const { PATCH } = await import("../src/app/api/projects/[id]/route.ts");
    const req = new Request("https://midplane.test/api", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dsn: ` ${GOOD_DSN} ` }),
    });
    const res = await PATCH(req, params);
    expect(res.status).toBe(200);
    expect(rotateProjectMock.mock.calls[0]?.[2]).toBe(GOOD_DSN);
  });
});
