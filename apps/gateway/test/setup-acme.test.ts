// `midplane setup --acme`, in process, against the stand-in cloud and the
// stand-in ACME directory: setup gets the certificate after the questions
// and before enrolling, and the gateway it configured serves it over HTTPS
// without ordering another. A failure leaves no files and the token unused.
// The one connection string fails its test and is kept, so no Postgres is
// needed: the gateway reports that database unreachable.

import { createHash, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLinkedConfig } from "../src/config.ts";
import type { Prompter } from "../src/prompt.ts";
import { startLinked } from "../src/server.ts";
import { runSetup, type SetupFlags, type SetupIO } from "../src/setup.ts";
import { type FakeAcme, startFakeAcme } from "./fake-acme.ts";
import { type FakeCloud, startFakeCloud } from "./fake-cloud.ts";

const POLLING = { firstMs: 5, limitMs: 5000 };
const DSN = "postgres://agent:secret@127.0.0.1:1/shop";

function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });
}

/** GET over TLS to the gateway, by name, trusting only the authority's CA. */
function getTls(
  port: number,
  path: string,
  ca: string,
): Promise<{ status: number; body: string; fingerprint: string }> {
  return new Promise((done, fail) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        servername: "gw.test",
        headers: { host: `gw.test:${port}` },
        ca,
        agent: false,
      },
      (res) => {
        const fingerprint = createHash("sha256")
          .update((res.socket as TLSSocket).getPeerCertificate().raw)
          .digest("hex");
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          body += d;
        });
        res.on("end", () =>
          done({ status: res.statusCode ?? 0, body, fingerprint }),
        );
      },
    );
    req.on("error", fail);
    req.end();
  });
}

describe("midplane setup --acme", { timeout: 30_000 }, () => {
  let cloud: FakeCloud;
  let acme: FakeAcme;
  let base: string;

  beforeAll(async () => {
    cloud = await startFakeCloud();
    acme = await startFakeAcme();
    base = mkdtempSync(join(tmpdir(), "midplane-setup-acme-"));
  });
  afterAll(async () => {
    await acme?.close();
    await cloud?.close();
  });

  const setup = async (dir: string, token: string) => {
    const httpPort = await freePort();
    acme.challengePort = httpPort;
    const answers = ["y", DSN, "keep", "", "n"];
    const prompter: Prompter = {
      ask: async () => answers.shift() ?? "",
      close: () => {},
    };
    let out = "";
    const flags: SetupFlags = {
      cloud: cloud.url,
      token,
      url: "https://gw.test",
      acme: true,
      "acme-directory": acme.url,
      port: String(await freePort()),
      dir,
      "no-start": true,
    };
    const io: SetupIO = {
      prompter,
      out: (text) => {
        out += text;
      },
      inContainer: false,
      npx: false,
      acme: { httpPort, polling: POLLING },
    };
    try {
      const result = await runSetup(flags, io);
      return { result, out, httpPort, error: null };
    } catch (error) {
      return { result: null, out, httpPort, error: error as Error };
    }
  };

  // protects=an ACME failure during setup leaves the token unused and no files behind, and says what to fix;
  // fails_when=a file survives, enrollment is tried, or the authority's type and detail are lost;
  // no_claim=Let's Encrypt's wording of its detail
  it("stops before enrolling when the authority refuses, and leaves nothing", async () => {
    const token = cloud.enrollmentToken();
    const enrolls = () =>
      cloud.bodies.filter((b) => b.path === "/link/v1/enroll").length;
    const before = enrolls();
    acme.failValidation = {
      type: "urn:ietf:params:acme:error:dns",
      detail: "DNS problem: NXDOMAIN looking up A for gw.test",
    };
    const failed = await setup(join(base, "refused"), token);
    acme.failValidation = null;
    expect(failed.error?.message).toBe(
      [
        "the DNS for gw.test doesn't point at this server",
        `  the ACME server at ${new URL(acme.url).host} said: DNS problem: NXDOMAIN looking up A for gw.test (dns)`,
        "Setup removed the files it wrote; the token is unused.",
      ].join("\n"),
    );
    expect(failed.out).toContain(
      `Getting a certificate for gw.test from the ACME server at ${new URL(acme.url).host}…\n`,
    );
    expect(existsSync(join(base, "refused"))).toBe(false);
    expect(enrolls()).toBe(before);

    // The token was never spent: it enrolls now.
    const ok = await setup(join(base, "after"), token);
    expect(ok.error).toBeNull();
    expect(enrolls()).toBe(before + 1);
  });

  // protects=setup --acme gets a certificate the authority issued, before enrolling, and the gateway it set up serves it over HTTPS without another order;
  // fails_when=no certificate is kept, enrollment comes first, the gateway orders again, or serves another certificate;
  // no_claim=Let's Encrypt itself (Pebble does this in the image, in the package smoke)
  it("gets the certificate, enrolls, and the gateway serves it over HTTPS", async () => {
    const dir = join(base, "served");
    const orders = acme.newOrders;
    const { result, out, error } = await setup(dir, cloud.enrollmentToken());
    expect(error).toBeNull();
    expect(acme.newOrders).toBe(orders + 1);
    expect(out).toMatch(
      /Getting a certificate for gw\.test from the ACME server at [^…]+…\n {2}ok: valid until \d{4}-\d{2}-\d{2}\n/,
    );
    // The certificate came before the enrollment's summary.
    expect(out.indexOf("ok: valid until")).toBeLessThan(
      out.indexOf("Enrolled gateway gw.test"),
    );
    expect(out).toContain(
      `Start it again with:\n  midplane gateway --config ${join(dir, "midplane.yaml")}`,
    );
    expect(readdirSync(dir).sort()).toEqual([
      "acme",
      "identity.json",
      "midplane.yaml",
      "secrets",
    ]);
    expect(readdirSync(join(dir, "acme")).sort()).toEqual([
      "account.key",
      "cert.pem",
      "key.pem",
    ]);
    const cert = readFileSync(join(dir, "acme", "cert.pem"), "utf8");
    expect(new X509Certificate(cert).checkHost("gw.test")).toBe("gw.test");

    const config = loadLinkedConfig(result?.configPath as string, {});
    expect(config.tls).toMatchObject({ kind: "acme", names: ["gw.test"] });
    const gateway = await startLinked(config, {
      certificates: { timing: { polling: POLLING } },
    });
    try {
      expect(acme.newOrders).toBe(orders + 1);
      const got = await getTls(config.listen.port, "/healthz", acme.ca);
      expect(got.status).toBe(200);
      expect(got.body).toBe("ok");
      expect(got.fingerprint).toBe(
        createHash("sha256")
          .update(new X509Certificate(cert).raw)
          .digest("hex"),
      );
    } finally {
      await gateway.close();
    }
  });
});
