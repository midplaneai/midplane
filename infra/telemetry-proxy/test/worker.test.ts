import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { type Env } from "../src/index.ts";

const VALID_INSTALL_ID = "01H8K2J9XQVWZ7PCQ3F0R2N5T8";
const VALID_TS = 1_730_000_000;

const validStartup = {
  schema_version: 1,
  event: "startup",
  install_id: VALID_INSTALL_ID,
  ts: VALID_TS,
  version: "0.2.0",
  bun_version: "1.3.0",
  os: "linux",
  arch: "x64",
  transport: "http",
  container: true,
  ci: false,
} as const;

const validHeartbeat = {
  schema_version: 1,
  event: "heartbeat",
  install_id: VALID_INSTALL_ID,
  ts: VALID_TS,
  version: "0.2.0",
  uptime_s: 86_400,
  window_s: 86_400,
  tools: {
    query: { calls: 10, allow: 9, deny: 1 },
  },
  denials_by_rule: { writes_require_approval: 1 },
  // Locked enum values like "SELECT" are legitimate here — the sanitizer
  // exempts them from the forbidden-substring scan.
  statement_types: { SELECT: 9, INSERT: 0, UPDATE: 0, DELETE: 0, DDL: 0, OTHER: 0 },
  latency_overhead_ms: { p50: 1, p95: 5, p99: 10, samples: 9 },
  exec_failures: { count: 0, by_sqlstate_class: {} },
} as const;

function makeCtx() {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    flush: () => Promise.allSettled(promises),
  };
}

function postEvents(body: string | object, method: string = "POST", path: string = "/v1/events") {
  return new Request(`https://t.midplane.ai${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const envWithSecret: Env = {
  POSTHOG_HOST: "https://posthog.local",
  POSTHOG_PROJECT_KEY: "phc_test",
};

describe("telemetry-proxy worker", () => {
  // The CF Worker `fetch` overload conflicts with vitest's generic MockInstance
  // signature; `any` here is a typing escape hatch, not a runtime issue.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("routing", () => {
    it("GET /healthz returns 200 'ok'", async () => {
      const { ctx } = makeCtx();
      const res = await worker.fetch(
        new Request("https://t.midplane.ai/healthz", { method: "GET" }),
        envWithSecret,
        ctx,
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("GET /v1/events returns 405", async () => {
      const { ctx } = makeCtx();
      const res = await worker.fetch(postEvents("", "GET"), envWithSecret, ctx);
      expect(res.status).toBe(405);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("POST /unknown returns 405", async () => {
      const { ctx } = makeCtx();
      const res = await worker.fetch(postEvents(validStartup, "POST", "/unknown"), envWithSecret, ctx);
      expect(res.status).toBe(405);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("PUT /v1/events returns 405", async () => {
      const { ctx } = makeCtx();
      const res = await worker.fetch(postEvents(validStartup, "PUT"), envWithSecret, ctx);
      expect(res.status).toBe(405);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("valid payloads", () => {
    it("forwards a startup event to PostHog with the right shape", async () => {
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(postEvents(validStartup), envWithSecret, ctx);
      expect(res.status).toBe(204);

      await flush();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://posthog.local/capture/");
      expect((init as RequestInit).method).toBe("POST");

      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toMatchObject({
        api_key: "phc_test",
        event: "midplane_startup",
        distinct_id: VALID_INSTALL_ID,
        timestamp: new Date(VALID_TS * 1000).toISOString(),
      });
      // install_id and ts must NOT appear in properties.
      expect(body.properties).not.toHaveProperty("install_id");
      expect(body.properties).not.toHaveProperty("ts");
      // Other fields land in properties.
      expect(body.properties).toMatchObject({
        version: "0.2.0",
        bun_version: "1.3.0",
        os: "linux",
        arch: "x64",
        transport: "http",
        container: true,
        ci: false,
      });
    });

    it("forwards a heartbeat event with locked-enum SQL keywords intact", async () => {
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(postEvents(validHeartbeat), envWithSecret, ctx);
      expect(res.status).toBe(204);

      await flush();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.event).toBe("midplane_heartbeat");
      expect(body.properties.statement_types).toEqual({
        SELECT: 9,
        INSERT: 0,
        UPDATE: 0,
        DELETE: 0,
        DDL: 0,
        OTHER: 0,
      });
    });

    it("does not forward inbound headers (no cf-connecting-ip leak)", async () => {
      const { ctx, flush } = makeCtx();
      const req = new Request("https://t.midplane.ai/v1/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.42",
          "x-forwarded-for": "203.0.113.42",
        },
        body: JSON.stringify(validStartup),
      });
      await worker.fetch(req, envWithSecret, ctx);
      await flush();

      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      const headers = new Headers(init.headers);
      expect(headers.has("cf-connecting-ip")).toBe(false);
      expect(headers.has("x-forwarded-for")).toBe(false);
    });
  });

  describe("rejected payloads (always 204, never forward)", () => {
    it("invalid install_id (not a ULID)", async () => {
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(
        postEvents({ ...validStartup, install_id: "not-a-ulid" }),
        envWithSecret,
        ctx,
      );
      expect(res.status).toBe(204);
      await flush();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("malformed JSON", async () => {
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(postEvents("{not valid json"), envWithSecret, ctx);
      expect(res.status).toBe(204);
      await flush();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("payload with 'SELECT' in version field is rejected as forbidden substring", async () => {
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(
        postEvents({ ...validStartup, version: "0.2.0-SELECT-leak" }),
        envWithSecret,
        ctx,
      );
      expect(res.status).toBe(204);
      await flush();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("unknown extra field rejected by strict zod", async () => {
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(
        postEvents({ ...validStartup, sneaky: "extra" }),
        envWithSecret,
        ctx,
      );
      expect(res.status).toBe(204);
      await flush();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("future schema_version rejected", async () => {
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(
        postEvents({ ...validStartup, schema_version: 99 }),
        envWithSecret,
        ctx,
      );
      expect(res.status).toBe(204);
      await flush();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("empty body", async () => {
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(postEvents(""), envWithSecret, ctx);
      expect(res.status).toBe(204);
      await flush();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("missing secret", () => {
    it("returns 204 silently and does not forward when POSTHOG_PROJECT_KEY is unset", async () => {
      const { ctx, flush } = makeCtx();
      const env: Env = { POSTHOG_HOST: "https://posthog.local" };
      const res = await worker.fetch(postEvents(validStartup), env, ctx);
      expect(res.status).toBe(204);
      await flush();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("forward resilience", () => {
    it("PostHog 5xx does not break the response (already 204'd)", async () => {
      fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 503 }));
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(postEvents(validStartup), envWithSecret, ctx);
      expect(res.status).toBe(204);
      await expect(flush()).resolves.toBeDefined();
    });

    it("PostHog rejection does not throw (silent failure)", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("network down"));
      const { ctx, flush } = makeCtx();
      const res = await worker.fetch(postEvents(validStartup), envWithSecret, ctx);
      expect(res.status).toBe(204);
      const settled = await flush();
      // The waitUntil promise should NOT propagate as rejected — Worker code
      // must swallow forward errors.
      expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    });
  });
});
