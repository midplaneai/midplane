// Unit coverage for the /api/projects/[id]/tokens REST surface
// (PR3 of mcp_url_auth_security).
//
// The route handlers are thin: validation + auth gate + call into
// apps/web/src/lib/tokens.ts (lib already covered in tokens.test.ts).
// These tests assert the shape contract — what HTTP codes the lib's
// typed errors and null returns translate into, and that the plaintext
// only leaves the surface on POST 201.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

const PEPPER_B64 = randomBytes(32).toString("base64");

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
let createTokenMock = vi.fn();
let listTokensMock = vi.fn();
let revokeTokenMock = vi.fn();

vi.mock("@/lib/customer", () => ({
  get currentCustomer() {
    return currentCustomerMock;
  },
}));

// The route reads identity through the getOrgContext seam (Better Auth under
// the hood); mock the seam, not the provider.
vi.mock("@/lib/org-context", () => ({
  get getOrgContext() {
    return getOrgContextMock;
  },
}));

vi.mock("@/lib/tokens", async () => {
  const real = await vi.importActual<typeof import("../src/lib/tokens.ts")>(
    "../src/lib/tokens.ts",
  );
  return {
    ...real,
    get createToken() {
      return createTokenMock;
    },
    get listTokens() {
      return listTokensMock;
    },
    get revokeToken() {
      return revokeTokenMock;
    },
  };
});

beforeEach(() => {
  currentCustomerMock = vi.fn(async () => customer as typeof customer | null);
  getOrgContextMock = vi.fn(async () => ({ userId: "user_1", orgId: "org_1" }));
  createTokenMock = vi.fn();
  listTokensMock = vi.fn();
  revokeTokenMock = vi.fn();
  process.env.MIDPLANE_KMS_MODE = "env";
  process.env.MIDPLANE_TOKEN_PEPPER_EU_V1 = PEPPER_B64;
  process.env.MIDPLANE_TOKEN_PEPPER_US_V1 = PEPPER_B64;
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadCollectionRoute() {
  return await import(
    "../src/app/api/projects/[id]/tokens/route.ts"
  );
}

async function loadItemRoute() {
  return await import(
    "../src/app/api/projects/[id]/tokens/[tokenId]/route.ts"
  );
}

function makeParams<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function jsonRequest(method: string, body?: unknown): Request {
  return new Request("https://midplane.test/api", {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function formRequest(method: string, fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields).toString();
  return new Request("https://midplane.test/api", {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("GET /api/projects/[id]/tokens", () => {
  it("401 when no session", async () => {
    currentCustomerMock = vi.fn(async () => null);
    const { GET } = await loadCollectionRoute();
    const res = await GET(jsonRequest("GET"), {
      params: makeParams({ id: "conn-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when listTokens returns null (unknown OR foreign — same leakage shape)", async () => {
    listTokensMock = vi.fn(async () => null);
    const { GET } = await loadCollectionRoute();
    const res = await GET(jsonRequest("GET"), {
      params: makeParams({ id: "conn-nope" }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("returns the dashboard-safe token list shape", async () => {
    const tokens = [
      {
        id: "tok-1",
        name: "laptop",
        prefix: "mp_test",
        last4: "abcd",
        createdByUserId: "user_clerk_1",
        createdAt: new Date("2026-05-01"),
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        lastUsedUa: null,
        status: "active" as const,
        revokedAt: null,
        revokedReason: null,
      },
    ];
    listTokensMock = vi.fn(async () => tokens);
    const { GET } = await loadCollectionRoute();
    const res = await GET(jsonRequest("GET"), {
      params: makeParams({ id: "conn-1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0].id).toBe("tok-1");
    // Belt-and-suspenders: the dashboard-safe shape from the lib never
    // contains a `tokenHash` or plaintext. This assertion catches any
    // future regression that would widen the lib's row shape to
    // include them.
    expect(body.tokens[0]).not.toHaveProperty("tokenHash");
    expect(body.tokens[0]).not.toHaveProperty("plaintext");
  });
});

describe("POST /api/projects/[id]/tokens", () => {
  it("400 on missing name", async () => {
    const { POST } = await loadCollectionRoute();
    const res = await POST(
      jsonRequest("POST", { expiresInDays: 90 }),
      { params: makeParams({ id: "conn-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("400 on bogus expiresInDays", async () => {
    const { POST } = await loadCollectionRoute();
    const res = await POST(
      jsonRequest("POST", { name: "x", expiresInDays: 7 }),
      { params: makeParams({ id: "conn-1" }) },
    );
    expect(res.status).toBe(400);
  });

  it("409 on duplicate name (DuplicateTokenName translates)", async () => {
    const { DuplicateTokenName } = await import("../src/lib/tokens.ts");
    createTokenMock = vi.fn(async () => {
      throw new DuplicateTokenName("laptop");
    });
    const { POST } = await loadCollectionRoute();
    const res = await POST(
      jsonRequest("POST", { name: "laptop", expiresInDays: 90 }),
      { params: makeParams({ id: "conn-1" }) },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "name_taken",
      takenName: "laptop",
    });
  });

  it("404 when createToken returns null (unknown OR foreign project)", async () => {
    createTokenMock = vi.fn(async () => null);
    const { POST } = await loadCollectionRoute();
    const res = await POST(
      jsonRequest("POST", { name: "laptop", expiresInDays: 90 }),
      { params: makeParams({ id: "conn-nope" }) },
    );
    expect(res.status).toBe(404);
  });

  it("201 returns the plaintext exactly once (the show-once contract)", async () => {
    createTokenMock = vi.fn(async () => ({
      id: "tok-2",
      plaintext: "mp_test_aaaa_bbbb",
    }));
    const { POST } = await loadCollectionRoute();
    const res = await POST(
      jsonRequest("POST", { name: "laptop", expiresInDays: 90 }),
      { params: makeParams({ id: "conn-1" }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.plaintext).toBe("mp_test_aaaa_bbbb");
    expect(body.id).toBe("tok-2");
    expect(body.name).toBe("laptop");
    expect(typeof body.expiresAt).toBe("string");
    // Lib was called with the env-derived prefix family (NODE_ENV !==
    // 'production' in tests → 'test'). Also assert the passed name
    // matches the body so the wire format isn't silently rewriting.
    expect(createTokenMock).toHaveBeenCalledOnce();
    const args = createTokenMock.mock.calls[0]!;
    expect(args[2].name).toBe("laptop");
    expect(args[2].env).toBe("test");
  });

  it("expiresInDays: null mints a never-expires token", async () => {
    createTokenMock = vi.fn(async () => ({
      id: "tok-3",
      plaintext: "mp_test_xxxx_yyyy",
    }));
    const { POST } = await loadCollectionRoute();
    const res = await POST(
      jsonRequest("POST", { name: "forever", expiresInDays: null }),
      { params: makeParams({ id: "conn-1" }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.expiresAt).toBeNull();
    const args = createTokenMock.mock.calls[0]!;
    expect(args[2].expiresAt).toBeNull();
  });

  it("form-encoded body: numeric expiresInDays arrives as a string and is coerced", async () => {
    // FormData submits stringify everything — without coercion the
    // numeric-literal union would 400 on a valid expiry. Regression test
    // for an earlier bug where the route accepted only JSON.
    createTokenMock = vi.fn(async () => ({
      id: "tok-4",
      plaintext: "mp_test_form_value",
    }));
    const { POST } = await loadCollectionRoute();
    const res = await POST(
      formRequest("POST", { name: "ci", expiresInDays: "90" }),
      { params: makeParams({ id: "conn-1" }) },
    );
    expect(res.status).toBe(201);
    const args = createTokenMock.mock.calls[0]!;
    expect(args[2].expiresAt).toBeInstanceOf(Date);
  });

  it("form-encoded body: expiresInDays='' coerces to never-expires", async () => {
    createTokenMock = vi.fn(async () => ({
      id: "tok-5",
      plaintext: "mp_test_forever_form",
    }));
    const { POST } = await loadCollectionRoute();
    const res = await POST(
      formRequest("POST", { name: "forever-form", expiresInDays: "" }),
      { params: makeParams({ id: "conn-1" }) },
    );
    expect(res.status).toBe(201);
    const args = createTokenMock.mock.calls[0]!;
    expect(args[2].expiresAt).toBeNull();
  });
});

describe("DELETE /api/projects/[id]/tokens/[tokenId]", () => {
  it("401 when no session", async () => {
    currentCustomerMock = vi.fn(async () => null);
    const { DELETE } = await loadItemRoute();
    const res = await DELETE(jsonRequest("DELETE"), {
      params: makeParams({ id: "conn-1", tokenId: "tok-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when revokeToken returns null (unknown OR foreign)", async () => {
    revokeTokenMock = vi.fn(async () => null);
    const { DELETE } = await loadItemRoute();
    const res = await DELETE(jsonRequest("DELETE"), {
      params: makeParams({ id: "conn-1", tokenId: "tok-nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("200 with id on success, idempotent (lib handles already-revoked)", async () => {
    revokeTokenMock = vi.fn(async () => ({ id: "tok-1" }));
    const { DELETE } = await loadItemRoute();
    const res = await DELETE(jsonRequest("DELETE"), {
      params: makeParams({ id: "conn-1", tokenId: "tok-1" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "tok-1" });
    const args = revokeTokenMock.mock.calls[0]!;
    expect(args[3].reason).toBe("user_action");
    expect(args[3].actorUserId).toBe("user_1");
  });

  it("accepts an empty body without choking the JSON parser", async () => {
    revokeTokenMock = vi.fn(async () => ({ id: "tok-1" }));
    const { DELETE } = await loadItemRoute();
    const res = await DELETE(
      new Request("https://midplane.test/api", { method: "DELETE" }),
      { params: makeParams({ id: "conn-1", tokenId: "tok-1" }) },
    );
    expect(res.status).toBe(200);
  });

  it("honors custom reason when supplied", async () => {
    revokeTokenMock = vi.fn(async () => ({ id: "tok-1" }));
    const { DELETE } = await loadItemRoute();
    const res = await DELETE(jsonRequest("DELETE", { reason: "rotated" }), {
      params: makeParams({ id: "conn-1", tokenId: "tok-1" }),
    });
    expect(res.status).toBe(200);
    expect(revokeTokenMock.mock.calls[0]![3].reason).toBe("rotated");
  });
});
