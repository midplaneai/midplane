import { afterEach, describe, expect, it, vi } from "vitest";

import { captureError } from "../src/lib/analytics.ts";
import { isLoopsConfigured, sendLoopsEvent } from "../src/lib/loops.ts";

// captureError is mocked (real redactForCapture kept) so the tests can see
// the only observable difference between "handled as success" and "reported
// as failure" — sendLoopsEvent itself always resolves undefined by design.
vi.mock("../src/lib/analytics.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/analytics.ts")>();
  return { ...actual, captureError: vi.fn() };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("isLoopsConfigured", () => {
  it("false without LOOPS_API_KEY", () => {
    expect(isLoopsConfigured({})).toBe(false);
    expect(isLoopsConfigured({ LOOPS_API_KEY: "" })).toBe(false);
  });

  it("true with LOOPS_API_KEY on cloud", () => {
    expect(isLoopsConfigured({ LOOPS_API_KEY: "k" })).toBe(true);
  });

  it("always false in self-host, even with a key set", () => {
    vi.stubEnv("MIDPLANE_SELF_HOST", "1");
    expect(isLoopsConfigured({ LOOPS_API_KEY: "k" })).toBe(false);
  });
});

describe("sendLoopsEvent", () => {
  it("no-ops without a key — fetch is never called", async () => {
    vi.stubEnv("LOOPS_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await sendLoopsEvent({ email: "a@b.co", eventName: "signup" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts with auth + idempotency headers, timeout signal, contact props top-level", async () => {
    vi.stubEnv("LOOPS_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await sendLoopsEvent({
      email: "a@b.co",
      userId: "u1",
      eventName: "signup",
      contactProperties: { region: "eu" },
      idempotencyKey: "signup-u1",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://app.loops.so/api/v1/events/send");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["Idempotency-Key"]).toBe("signup-u1");
    // A hung Loops endpoint must not stall signup — the request is
    // hard-capped by an abort signal.
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // Contact properties are TOP-LEVEL fields per the events/send contract.
    expect(JSON.parse(init.body as string)).toEqual({
      email: "a@b.co",
      userId: "u1",
      eventName: "signup",
      region: "eu",
    });
  });

  it("strips reserved keys from contact properties entirely", async () => {
    vi.stubEnv("LOOPS_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    // userId/mailingLists have no explicit field below (args.userId absent),
    // so only a strip — not spread order — keeps them from acquiring API
    // semantics like re-associating the contact.
    await sendLoopsEvent({
      email: "a@b.co",
      eventName: "signup",
      contactProperties: {
        email: "spoof@x.co",
        eventName: "other",
        userId: "hijack",
        mailingLists: "x",
        region: "eu",
      },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      email: "a@b.co",
      eventName: "signup",
      region: "eu",
    });
  });

  it("nests eventProperties (per-event data) and omits Idempotency-Key without a key", async () => {
    vi.stubEnv("LOOPS_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await sendLoopsEvent({
      email: "a@b.co",
      eventName: "signup",
      eventProperties: { plan: "free" },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
    // Unlike contactProperties, eventProperties stay NESTED under their key.
    expect(JSON.parse(init.body as string)).toEqual({
      email: "a@b.co",
      eventName: "signup",
      eventProperties: { plan: "free" },
    });
  });

  it("treats a 409 as replay-success only when an idempotency key was sent", async () => {
    vi.stubEnv("LOOPS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("dupe", { status: 409 })),
    );
    await expect(
      sendLoopsEvent({
        email: "a@b.co",
        eventName: "signup",
        idempotencyKey: "signup-u1",
      }),
    ).resolves.toBeUndefined();
    // The function always resolves; NOT capturing is what distinguishes a
    // replay-as-success from a reported failure.
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
  });

  it("reports a 409 as a failure when no idempotency key was sent", async () => {
    vi.stubEnv("LOOPS_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("conflict", { status: 409 })),
    );
    // Without a key, 409 is some other conflict — must not be silently
    // classified as success.
    await expect(
      sendLoopsEvent({ email: "a@b.co", eventName: "signup" }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(captureError)).toHaveBeenCalledOnce();
  });

  it("never throws on a rejected fetch (signup path must survive) — failure is captured", async () => {
    vi.stubEnv("LOOPS_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    await expect(
      sendLoopsEvent({ email: "a@b.co", eventName: "signup" }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(captureError)).toHaveBeenCalledOnce();
  });

  it("redacts PII (email, name) but not enum props from the captured failure", async () => {
    vi.stubEnv("LOOPS_API_KEY", "test-key");
    // Providers echo the submitted payload back on validation errors — the
    // captured message must carry neither the email nor the name. But the
    // region enum ("eu"/"us") must survive: redaction is substring-based,
    // and scrubbing "us" would mangle words like "status" in the diagnostics.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("status: invalid recipient A@B.CO for contact Ada (eu)", {
            status: 400,
          }),
        ),
    );
    await expect(
      sendLoopsEvent({
        email: "a@b.co",
        eventName: "signup",
        contactProperties: { firstName: "Ada", region: "eu" },
      }),
    ).resolves.toBeUndefined();
    expect(vi.mocked(captureError)).toHaveBeenCalledOnce();
    const captured = vi.mocked(captureError).mock.calls[0]?.[1] as Error;
    expect(captured.message).not.toMatch(/a@b\.co/i);
    expect(captured.message).not.toContain("Ada");
    expect(captured.message).toContain("[redacted]");
    expect(captured.message).toContain("status");
    expect(captured.message).toContain("(eu)");
  });
});
