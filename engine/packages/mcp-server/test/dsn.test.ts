// dsn.ts — the credential-safety helpers. One copy, tested once, used by
// policy/doctor/init/query; the password-never-leaks property is the point.

import { describe, expect, test } from "bun:test";
import { displayHost, ensureHttpScheme, isLoopbackHost, scrub } from "../src/dsn.ts";

const DSN = "postgres://midplane:sekrit-password@db.example.com:5433/appdb";

describe("displayHost", () => {
  test("shows host:port/db, never the userinfo", () => {
    const out = displayHost(DSN);
    expect(out).toBe("db.example.com:5433/appdb");
    expect(out).not.toContain("sekrit-password");
    expect(out).not.toContain("midplane:");
  });

  test("defaults the port and survives garbage", () => {
    expect(displayHost("postgres://u:p@h/db")).toBe("h:5432/db");
    expect(displayHost("not a url")).toBe("<unparseable dsn>");
  });
});

describe("scrub", () => {
  test("removes every occurrence of the secret", () => {
    const msg = `connect failed for ${DSN} (retried ${DSN})`;
    const out = scrub(msg, DSN);
    expect(out).toBe("connect failed for <dsn> (retried <dsn>)");
    expect(out).not.toContain("sekrit-password");
  });

  test("empty secret passes the message through", () => {
    expect(scrub("hello", "")).toBe("hello");
  });
});

describe("ensureHttpScheme", () => {
  test("adds http:// to bare host:port; preserves explicit schemes", () => {
    expect(ensureHttpScheme("example.com:9000")).toBe("http://example.com:9000");
    expect(ensureHttpScheme("https://example.com")).toBe("https://example.com");
  });
});

describe("isLoopbackHost", () => {
  test("loopback forms yes; everything else no", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });
});
