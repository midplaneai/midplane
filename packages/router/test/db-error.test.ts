// Opaque-error boundary for DB/engine/network failures. The assertions pin the
// bright line (engine/TELEMETRY.md "What we never send"): a driver error's raw
// text — table/column names, DB host/user, full SQLSTATE — must never survive
// `safeErrorDetail`, while our own curated messages must pass through so the
// dry-run/preview `detail` vocabulary and control-plane logs stay legible.

import { describe, expect, it } from "vitest";

import { safeErrorDetail, sanitizeDbError } from "../src/db-error.ts";

// A postgres-js / pg server error: SQLSTATE in `.code`, identifiers in the
// message + side fields.
function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("safeErrorDetail — driver errors collapse to an opaque class", () => {
  it("reduces a Postgres SQLSTATE to its 2-char class, dropping the message", () => {
    const err = pgError("42P01", 'relation "salaries" does not exist');
    const out = safeErrorDetail(err);
    expect(out).toBe("pg_42");
    expect(out).not.toContain("salaries");
    expect(out).not.toContain("42P01"); // full code pairs with the table name
  });

  it("masks auth failures (28P01) without echoing the role name", () => {
    const out = safeErrorDetail(
      pgError("28P01", 'password authentication failed for user "app_ro"'),
    );
    expect(out).toBe("pg_28");
    expect(out).not.toContain("app_ro");
  });

  it("collapses connection errors that carry the DB host", () => {
    const econn = Object.assign(
      new Error("connect ECONNREFUSED 10.0.3.7:5432"),
      { code: "ECONNREFUSED" },
    );
    const out = safeErrorDetail(econn);
    expect(out).toBe("net_ECONNREFUSED");
    expect(out).not.toContain("10.0.3.7");
  });

  it("handles postgres-js connection codes and DNS failures", () => {
    expect(
      safeErrorDetail(
        Object.assign(new Error("write CONNECT_TIMEOUT db.internal:5432"), {
          code: "CONNECT_TIMEOUT",
        }),
      ),
    ).toBe("net_CONNECT_TIMEOUT");
    expect(
      safeErrorDetail(
        Object.assign(new Error("getaddrinfo ENOTFOUND prod-db.acme.internal"), {
          code: "ENOTFOUND",
        }),
      ),
    ).toBe("net_ENOTFOUND");
  });

  it("falls back to db_error for a coded error it can't classify", () => {
    const out = safeErrorDetail(
      Object.assign(new Error("schema 'payroll' tripped a weird path"), {
        code: "weird-lowercase-code",
      }),
    );
    expect(out).toBe("db_error");
    expect(out).not.toContain("payroll");
  });

  it("classifies a numeric code without leaking the message", () => {
    const out = safeErrorDetail(Object.assign(new Error("boom on table x"), { code: 1062 }));
    expect(out).not.toContain("table x");
    expect(out).toBe("db_error"); // 1062 is neither SQLSTATE-shaped nor errno-shaped
  });
});

describe("safeErrorDetail — curated app errors pass through", () => {
  it("preserves a deliberately-thrown control-plane message (no driver code)", () => {
    expect(safeErrorDetail(new Error("project disappeared during dry-run"))).toBe(
      "project disappeared during dry-run",
    );
  });

  it("stringifies non-Error throwns", () => {
    expect(safeErrorDetail("policy changed mid-run")).toBe("policy changed mid-run");
    expect(safeErrorDetail(null)).toBe("null");
  });
});

describe("sanitizeDbError", () => {
  it("wraps as an Error carrying only the safe detail", () => {
    const wrapped = sanitizeDbError(pgError("23505", 'duplicate key on "users_email_idx"'));
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.name).toBe("SanitizedDbError");
    expect(wrapped.message).toBe("pg_23");
    expect(wrapped.message).not.toContain("users_email_idx");
  });
});
