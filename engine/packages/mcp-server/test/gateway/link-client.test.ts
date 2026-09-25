// The link client's failure values. The pull loop tells "nothing new", "here
// is a bundle" and each kind of failure apart from these, so each one must come
// back as a value — and a redirect must never be followed, since every request
// token is bound to one path.

import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { LinkClient, type GatewaySigner } from "../../src/gateway/link-client.ts";
import { BUNDLE_PATH } from "../../src/gateway/protocol.ts";
import { testKey } from "./_fixtures.ts";

const key = testKey();
const signer: GatewaySigner = { gatewayId: "01GATEWAYAAAAAAAAAAAAAAAAA", audience: "http://127.0.0.1", privateKey: key.privateKey };

describe("LinkClient failures", () => {
  let server: Server | null = null;
  afterEach(async () => {
    server?.closeAllConnections?.();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = null;
  });

  test("redirects are refused, not followed; failure bodies are parsed when JSON and tolerated when not", async () => {
    // A real listener, so this pins what the runtime's fetch actually does
    // with redirect: "manual" — not what a stub pretends.
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(req.url ?? "");
      if (req.url === BUNDLE_PATH) {
        res.statusCode = 302;
        res.setHeader("location", "/elsewhere/bundle");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.end("x.y.z");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const res = await new LinkClient(origin, "t").fetchBundle(signer, 3);
    expect(res).toMatchObject({ kind: "error", status: 302, code: "redirect" });
    expect(seen).toEqual([BUNDLE_PATH]); // the target was never requested

    // Stubbed responses for the body-parsing branches.
    let next: Response = new Response(null);
    const stub = new LinkClient("https://cp.test", "t", (async () => next) as unknown as typeof fetch);

    next = new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
    expect(await stub.fetchBundle(signer, null)).toEqual({
      kind: "error",
      status: 502,
      code: null,
      message: "control plane returned HTTP 502",
      serverTime: null,
    });

    next = new Response(JSON.stringify({ error: "gateway_revoked" }), { status: 401 });
    expect(await stub.heartbeat(signer, { state: "serving" })).toMatchObject({ kind: "error", status: 401, code: "gateway_revoked" });

    next = new Response(null, { status: 204 });
    expect(await stub.heartbeat(signer, {})).toEqual({ kind: "ok" });

    next = new Response(JSON.stringify({ error: "enrollment_token_expired" }), { status: 410 });
    expect(await stub.enroll({ token: "mpe1_x" }, { privateKey: key.privateKey, publicKeyRaw: key.raw })).toMatchObject({
      kind: "error",
      status: 410,
      code: "enrollment_token_expired",
    });

    // An enroll answered with a redirect is refused like any other call.
    next = new Response(null, { status: 307, headers: { location: "https://evil.test/enroll" } });
    expect(await stub.enroll({ token: "mpe1_x" }, { privateKey: key.privateKey, publicKeyRaw: key.raw })).toMatchObject({
      code: "redirect",
    });
  });
});
