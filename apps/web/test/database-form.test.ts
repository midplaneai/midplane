// addDatabaseFromForm — the shared body of the dashboard's and the
// connection home's add-database server actions (REGRESSION-RISK: this
// logic moved out of the dashboard action where it shipped untested;
// the extraction is the moment to pin it). Validation messages are
// user-visible (the client form renders thrown Error messages inline),
// so the strings are part of the contract.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class NotFoundSentinel extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}

let addDatabaseMock = vi.fn(async () => ({ ok: true }) as unknown);

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSentinel();
  },
}));

vi.mock("@/lib/mcp-proxy", () => ({
  getMcpProxyContext: () => ({ fake: "ctx" }),
}));

vi.mock("@/lib/connections", async () => {
  const real = await vi.importActual<typeof import("../src/lib/connections.ts")>(
    "../src/lib/connections.ts",
  );
  return {
    ...real,
    get addDatabase() {
      return addDatabaseMock;
    },
  };
});

import { addDatabaseFromForm } from "../src/lib/database-form.ts";
import { DatabaseNameTaken } from "../src/lib/connections.ts";

const customer = {
  id: "01HZZZZZZZZZZZZZZZZZZZZZZZ",
  clerkOrgId: "org_clerk-1",
  email: "u@e.test",
  region: "eu" as const,
  createdAt: new Date(),
} as never;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const VALID = {
  connectionId: "conn-1",
  name: "analytics",
  dsn: "postgres://u:p@db.example.com/app",
  default_access: "deny",
};

beforeEach(() => {
  addDatabaseMock = vi.fn(async () => ({ ok: true }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("addDatabaseFromForm", () => {
  it("throws on missing connectionId (tamper-shape, not user-reachable)", async () => {
    const { connectionId: _omit, ...rest } = VALID;
    await expect(addDatabaseFromForm(customer, form(rest))).rejects.toThrow(
      /missing connectionId/,
    );
  });

  it("rejects invalid names and DSNs with the user-facing messages", async () => {
    await expect(
      addDatabaseFromForm(customer, form({ ...VALID, name: "9bad" })),
    ).rejects.toThrow(/1–32 lowercase/);
    await expect(
      addDatabaseFromForm(customer, form({ ...VALID, dsn: "mysql://nope" })),
    ).rejects.toThrow(/postgres:\/\//);
    expect(addDatabaseMock).not.toHaveBeenCalled();
  });

  it("trims the name and passes the chosen access level through", async () => {
    const result = await addDatabaseFromForm(
      customer,
      form({ ...VALID, name: "  analytics  " }),
    );
    expect(result).toEqual({ connectionId: "conn-1", name: "analytics" });
    expect(addDatabaseMock).toHaveBeenCalledWith(
      customer,
      "conn-1",
      "analytics",
      VALID.dsn,
      "deny",
      { fake: "ctx" },
    );
  });

  it("falls back to read on a tampered access value (same posture as createConnection)", async () => {
    await addDatabaseFromForm(
      customer,
      form({ ...VALID, default_access: "superuser" }),
    );
    const call = addDatabaseMock.mock.calls[0] as unknown as unknown[];
    expect(call[4]).toBe("read");
  });

  it("maps DatabaseNameTaken to the inline-renderable message", async () => {
    addDatabaseMock = vi.fn(async () => {
      throw new DatabaseNameTaken("analytics");
    });
    await expect(addDatabaseFromForm(customer, form(VALID))).rejects.toThrow(
      /"analytics" already exists/,
    );
  });

  it("404s (notFound) when the connection is unknown or foreign", async () => {
    addDatabaseMock = vi.fn(async () => null);
    await expect(addDatabaseFromForm(customer, form(VALID))).rejects.toThrow(
      NotFoundSentinel,
    );
  });
});
