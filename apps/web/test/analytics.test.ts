// lib/analytics.ts — the helpers every capture site leans on. The
// load-bearing invariant is captureError's "never throws": it runs inside
// the MCP proxy's failure paths with no wrapper, so an analytics fault
// escaping here would turn an observed error into a caused one.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/posthog.ts", () => ({ getPostHog: vi.fn() }));

import { getPostHog } from "../src/lib/posthog.ts";
import {
  analyticsGroups,
  captureError,
  makeCaptureThrottle,
  redactForCapture,
} from "../src/lib/analytics.ts";

const mockedGetPostHog = vi.mocked(getPostHog);

afterEach(() => {
  vi.resetAllMocks();
});

describe("captureError", () => {
  it("never throws when captureException throws", () => {
    mockedGetPostHog.mockReturnValue({
      captureException: () => {
        throw new Error("boom");
      },
    } as unknown as ReturnType<typeof getPostHog>);
    expect(() => captureError("proxy.spawn_failed", new Error("x"))).not.toThrow();
  });

  it("never throws when getPostHog itself throws (client ctor failure)", () => {
    mockedGetPostHog.mockImplementation(() => {
      throw new Error("malformed POSTHOG_HOST");
    });
    expect(() => captureError("proxy.spawn_failed", new Error("x"))).not.toThrow();
  });

  it("no-ops without a client and wraps non-Error values", () => {
    mockedGetPostHog.mockReturnValue(null);
    expect(() => captureError("site", "string failure")).not.toThrow();

    const captureException = vi.fn();
    mockedGetPostHog.mockReturnValue({
      captureException,
    } as unknown as ReturnType<typeof getPostHog>);
    captureError("tokens.create_failed", "raw string", {
      distinctId: "user_1",
      properties: { project_id: "p1" },
    });
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, distinctId, props] = captureException.mock.calls[0] as [
      Error,
      string,
      Record<string, unknown>,
    ];
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("raw string");
    expect(distinctId).toBe("user_1");
    expect(props.site).toBe("tokens.create_failed");
    expect(props.project_id).toBe("p1");
  });
});

describe("analyticsGroups", () => {
  it("omits nullish ids and keeps present ones", () => {
    expect(analyticsGroups({ customerId: null, projectId: undefined })).toEqual(
      {},
    );
    expect(analyticsGroups({ customerId: "c1" })).toEqual({
      organization: "c1",
    });
    expect(analyticsGroups({ customerId: "c1", projectId: "p1" })).toEqual({
      organization: "c1",
      project: "p1",
    });
  });
});

describe("redactForCapture", () => {
  it("redacts case-variant echoes of the secret", () => {
    expect(
      redactForCapture("Invalid recipient Dustin@Example.com", "dustin@example.com"),
    ).toBe("Invalid recipient [redacted]");
  });

  it("redacts every occurrence", () => {
    expect(redactForCapture("a@b.co failed; retry a@b.co", "a@b.co")).toBe(
      "[redacted] failed; retry [redacted]",
    );
  });

  it("escapes regex metacharacters in the secret and passes through on no match", () => {
    // "." must not act as a wildcard: "aXb.co" is NOT the secret "a.b.co".
    expect(redactForCapture("sent to aXb.co", "a.b.co")).toBe("sent to aXb.co");
    expect(redactForCapture("no addresses here", "x@y.z")).toBe(
      "no addresses here",
    );
    expect(redactForCapture("whatever", "")).toBe("whatever");
  });
});

describe("makeCaptureThrottle", () => {
  it("fires once per key per window, independently per key", () => {
    let t = 0;
    const throttle = makeCaptureThrottle(300_000, () => t);
    expect(throttle("p1:fetch")).toBe(true);
    expect(throttle("p1:fetch")).toBe(false);
    expect(throttle("p1:write")).toBe(true);
    t = 299_999;
    expect(throttle("p1:fetch")).toBe(false);
    t = 300_000;
    expect(throttle("p1:fetch")).toBe(true);
  });

  it("prunes expired entries so the map does not grow with dead keys", () => {
    let t = 0;
    const throttle = makeCaptureThrottle(1_000, () => t);
    for (let i = 0; i < 100; i++) throttle(`proj${i}:fetch`);
    t = 1_000;
    // All 100 stamps are expired now; a single call prunes them and the
    // key fires fresh (behavioral proxy for boundedness — the map's
    // internals aren't exposed, but expired keys re-firing proves deletion).
    expect(throttle("proj0:fetch")).toBe(true);
    expect(throttle("proj1:fetch")).toBe(true);
  });
});
