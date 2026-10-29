// `midplane setup --relay`, and `midplane start` without MIDPLANE_URL, in
// process, against the stand-in cloud, ACME directory and relay: each asks
// the cloud where its relay is, enrolls at its relay URL and writes the
// config #67's gateway loads; then that gateway opens its work connections,
// gets its certificate through the relay and answers there, as the agents'
// URL setup's last line names. No certificate is ordered before enrolling.
// A proxy that forges where the relay is gets nothing set up (#105).
// The one connection string fails its test and is kept, so no Postgres is
// needed; a query through the relay is the cloud's test with the real relay
// (relay-gateway.e2e.test.ts).

import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadParser } from "@midplane/core";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { generateSigningKey } from "../src/auth.ts";
import { loadLinkedConfig } from "../src/config.ts";
import type { Prompter } from "../src/prompt.ts";
import { type RunningGateway, startLinked } from "../src/server.ts";
import { runSetup } from "../src/setup.ts";
import { startConfig } from "../src/start.ts";
import { type FakeAcme, startFakeAcme } from "./fake-acme.ts";
import { type FakeCloud, relayProof, startFakeCloud } from "./fake-cloud.ts";
import {
  type StandInRelay,
  startStandInRelay,
  viaRelay,
} from "./stand-in-relay.ts";

const DOMAIN = "eu.relay.test";
const CONTROL = `relay.${DOMAIN}`;
const DSN = "postgres://agent:secret@127.0.0.1:1/shop";
const POLLING = { firstMs: 5, limitMs: 5000 };

describe("set up behind the relay", { timeout: 30_000 }, () => {
  let base: string;
  /** What each test started, closed after it. */
  let open: {
    cloud: FakeCloud;
    relay: StandInRelay;
    acme: FakeAcme;
    gateway?: RunningGateway;
  } | null = null;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "midplane-setup-relay-"));
    await loadParser();
  });
  afterEach(async () => {
    await open?.gateway?.close();
    await open?.relay.close();
    await open?.acme.close();
    await open?.cloud.close();
    open = null;
  });

  /** A cloud with a relay, the relay, and an ACME directory that checks through it. */
  const world = async () => {
    const cloud = await startFakeCloud({ relayDomain: DOMAIN });
    const relay = await startStandInRelay({
      control: CONTROL,
      source: { address: "203.0.113.7", port: 51234 },
    });
    const acme = await startFakeAcme({ challengePort: relay.httpPort });
    open = { cloud, relay, acme };
    return open;
  };

  /**
   * The gateway a config describes, started as `midplane gateway` would but
   * with the stand-in relay where the relay's name would lead; then a
   * request through the relay, by the relay URL.
   */
  const serveThroughRelay = async (
    configPath: string,
    env: NodeJS.ProcessEnv,
  ) => {
    const { relay, acme } = open as NonNullable<typeof open>;
    const config = loadLinkedConfig(configPath, env);
    const gateway = await startLinked(config, {
      relay: { connect: { host: "127.0.0.1", port: relay.port }, ca: relay.ca },
      certificates: { timing: { polling: POLLING } },
    });
    (open as NonNullable<typeof open>).gateway = gateway;
    const url = config.publicUrls[0] as string;
    const peers: string[] = [];
    const agent = viaRelay(relay.agentPort, acme.ca, peers);
    const health = await agent(`${url}/healthz`);
    const metadata = await agent(
      `${url}/.well-known/oauth-protected-resource/mcp`,
    );
    return {
      gateway,
      url,
      peers,
      health: { status: health.status, body: await health.text() },
      resource: ((await metadata.json()) as { resource?: string }).resource,
    };
  };

  // protects=criterion 1, interactive: `setup --relay` asks the cloud for its relay, enrolls at https://<slug>.<relay domain>/mcp, orders no certificate before enrolling, writes the relay config (control name, the one relay URL, tls.acme, loopback), and ends on the agents' URL; #67's gateway loads it and answers through the relay at that URL, with the certificate it got there;
  // fails_when=the URL isn't on the cloud's relay domain, a certificate is ordered before enrolling, the config isn't one the gateway serves relayed, the listener leaves loopback, the summary ends elsewhere, or the gateway answers with another certificate or not at all;
  // no_claim=the real relay and cloud (relay-gateway.e2e.test.ts), Let's Encrypt (Pebble is #69's smoke), or a query (no database here)
  it("setup --relay writes a config the gateway serves through the relay", async () => {
    const { cloud, relay, acme } = await world();
    const dir = join(base, "interactive");
    const answers = ["y", DSN, "keep", "", "n"];
    const prompter: Prompter = {
      ask: async () => answers.shift() ?? "",
      close: () => {},
    };
    let out = "";
    const { configPath } = await runSetup(
      {
        cloud: cloud.url,
        token: cloud.enrollmentToken(),
        relay: true,
        "acme-directory": acme.url,
        dir,
        "no-start": true,
      },
      {
        prompter,
        out: (text) => {
          out += text;
        },
        inContainer: false,
        npx: false,
      },
    );
    const [resource] = cloud.registered;
    expect(resource).toMatch(
      /^https:\/\/gw-[0-9a-z]{8}\.eu\.relay\.test\/mcp$/,
    );
    const relayUrl = (resource as string).slice(0, -"/mcp".length);
    // Enrolled with no certificate yet: it comes through the relay at start.
    expect(acme.newOrders).toBe(0);
    expect(readdirSync(dir).sort()).toEqual([
      "identity.json",
      "midplane.yaml",
      "secrets",
    ]);
    expect(parseYaml(readFileSync(configPath, "utf8"))).toMatchObject({
      listen: { host: "127.0.0.1" },
      relay: { control: CONTROL },
      public_urls: [relayUrl],
      tls: { acme: { directory_url: acme.url } },
      link: { name: new URL(relayUrl).host },
    });
    expect(out).toContain(
      `Setting up gateway ${new URL(relayUrl).host} in ${dir}, at ${relayUrl}, through Midplane's relay (${CONTROL}).`,
    );
    expect(out.trimEnd().split("\n").at(-1)).toBe(
      `Agents reach it at ${resource}, through Midplane's relay, once the gateway has its certificate.`,
    );
    expect(out).toContain(
      `Start it again with:\n  midplane gateway --config ${configPath}`,
    );

    const served = await serveThroughRelay(configPath, {});
    expect(served.url).toBe(relayUrl);
    expect(served.health).toEqual({ status: 200, body: "ok" });
    expect(served.resource).toBe(resource);
    // Its certificate came through the relay's port 80, for its relay host.
    expect(acme.newOrders).toBe(1);
    expect(relay.lines.filter((l) => / 80\r\n$/.test(l))).toHaveLength(1);
    const cert = new X509Certificate(
      readFileSync(join(dir, "acme", "cert.pem"), "utf8"),
    );
    expect(cert.checkHost(new URL(relayUrl).host)).toBe(new URL(relayUrl).host);
    expect(new Set(served.peers)).toEqual(new Set([cert.fingerprint256]));
    expect(served.gateway.listener).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
  });

  // protects=criterion 1, from the environment: `start` without MIDPLANE_URL asks the cloud for its relay, enrolls at its relay URL, keeps the connection string in its variable, and its last setup line names the agents' URL; the gateway it hands over loads the config and answers through the relay, and the cloud hears its work connections;
  // fails_when=start still wants MIDPLANE_URL, sets up a direct gateway, writes the connection string, ends on another line, or the gateway doesn't serve through the relay or report it;
  // no_claim=Docker or the image (#69's smoke runs one `docker run --env-file`), or a query (no database here)
  it("start without MIDPLANE_URL sets up a gateway that serves through the relay", async () => {
    const { cloud, acme, relay } = await world();
    const volume = join(base, "volume");
    const env: NodeJS.ProcessEnv = {
      MIDPLANE_CLOUD_URL: cloud.url,
      MIDPLANE_ENROLLMENT_TOKEN: cloud.enrollmentToken(),
      MIDPLANE_ACME_DIRECTORY: acme.url,
      MIDPLANE_DSN_SHOP: DSN,
    };
    const lines: Record<string, unknown>[] = [];
    const configPath = await startConfig({
      config: join(base, "nothing-mounted", "midplane.yaml"),
      dir: volume,
      env,
      log: (fields) => lines.push(fields),
      inContainer: false,
    });
    const [resource] = cloud.registered;
    expect(resource).toMatch(
      /^https:\/\/gw-[0-9a-z]{8}\.eu\.relay\.test\/mcp$/,
    );
    expect(lines[0]).toMatchObject({ relay: CONTROL, databases: ["shop"] });
    expect(lines.at(-1)).toEqual({
      level: "info",
      msg: `Agents reach it at ${resource}, through Midplane's relay, once the gateway has its certificate.`,
      mcp_url: resource,
    });
    expect(acme.newOrders).toBe(0);
    const yaml = readFileSync(configPath, "utf8");
    expect(yaml).not.toContain(DSN);
    expect(yaml).not.toContain(":secret@");
    expect(parseYaml(yaml)).toMatchObject({
      listen: { host: "127.0.0.1" },
      relay: { control: CONTROL },
      tls: { acme: { directory_url: acme.url } },
      databases: { shop: { dsn: { env: "MIDPLANE_DSN_SHOP" } } },
    });

    const served = await serveThroughRelay(configPath, env);
    expect(`${served.url}/mcp`).toBe(resource);
    expect(served.health).toEqual({ status: 200, body: "ok" });
    expect(served.resource).toBe(resource);
    expect(acme.newOrders).toBe(1);
    expect(relay.idle()).toBeGreaterThan(0);
    const until = Date.now() + 10_000;
    while (!cloud.statuses.some((s) => (s.relay?.idle ?? 0) > 0)) {
      if (Date.now() > until) throw new Error("no status with the relay");
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  // protects=criterion 2 of #105: a proxy that intercepts TLS between setup and the cloud and names another relay, signing for setup's nonce with a key of its own or not signing at all, gets nothing set up, interactively or from the environment: nothing is written, nothing enrolls, and the relay at the domain it named never hears from a gateway; the token stays unused, and with the cloud's own answer it sets up a gateway that dials the cloud's relay only;
  // fails_when=setup believes an answer the token's pin doesn't verify, writes or enrolls before checking it, spends the token, or a gateway ever opens a work connection at the forged domain;
  // no_claim=a proxy that holds the cloud's signing key (nothing setup can tell from the cloud), or the link after enrollment (link.e2e.test.ts pins the bundle key there)
  it("refuses a forged answer naming another relay, which no gateway ever dials", async () => {
    const { cloud, relay, acme } = await world();
    const forged = await startStandInRelay({
      control: "relay.evil.test",
      source: { address: "203.0.113.7", port: 51234 },
    });
    try {
      const own = await generateSigningKey();
      const elsewhere = { domain: "evil.test", control: "relay.evil.test" };
      /** The proxy's answer to where the relay is: its own signature, or none. */
      const forgeries = {
        signed: async (nonce: string) => ({
          ...elsewhere,
          signing_key: own.publicJwk,
          proof: await relayProof(own.privateJwk, {
            iss: cloud.url,
            domain: elsewhere.domain,
            nonce,
          }),
        }),
        stripped: async () => elsewhere,
      };
      const through =
        (forge: (nonce: string) => Promise<unknown>): typeof fetch =>
        async (input, init) => {
          const url = new URL(String(input));
          if (url.pathname !== "/link/v1/relay") return fetch(input, init);
          return Response.json(
            await forge(url.searchParams.get("nonce") ?? ""),
          );
        };
      const token = cloud.enrollmentToken();
      const env: NodeJS.ProcessEnv = {
        MIDPLANE_CLOUD_URL: cloud.url,
        MIDPLANE_ENROLLMENT_TOKEN: token,
        MIDPLANE_ACME_DIRECTORY: acme.url,
        MIDPLANE_DSN_SHOP: DSN,
      };
      const refused = {
        signed: `Midplane Cloud at ${cloud.url} signed where its relay is with a key the enrollment token doesn't pin`,
        stripped: `Midplane Cloud at ${cloud.url} didn't sign where its relay is for this setup`,
      };
      for (const how of ["signed", "stripped"] as const) {
        const dir = join(base, `forged-${how}`);
        const prompter: Prompter = {
          ask: async () => {
            throw new Error("asked a question");
          },
          close: () => {},
        };
        await expect(
          runSetup(
            {
              cloud: cloud.url,
              token,
              relay: true,
              "acme-directory": acme.url,
              dir,
              "no-start": true,
            },
            {
              prompter,
              out: () => {},
              inContainer: false,
              npx: false,
              fetch: through(forgeries[how]),
            },
          ),
        ).rejects.toThrow(refused[how]);
        const volume = join(base, `forged-${how}-volume`);
        const set = startConfig({
          config: join(base, "nothing-mounted", "midplane.yaml"),
          dir: volume,
          env,
          log: () => {},
          inContainer: false,
          fetch: through(forgeries[how]),
        });
        await expect(set).rejects.toThrow(refused[how]);
        await expect(set).rejects.toThrow(
          "Nothing was written, and the token is unused.",
        );
        expect(existsSync(dir)).toBe(false);
        expect(existsSync(volume)).toBe(false);
      }
      expect(cloud.gatewayId).toBeNull();
      expect(cloud.bodies.map((b) => b.path)).not.toContain("/link/v1/enroll");

      // The same token, with the cloud's own answer: the cloud's relay only.
      const configPath = await startConfig({
        config: join(base, "nothing-mounted", "midplane.yaml"),
        dir: join(base, "honest-volume"),
        env,
        log: () => {},
        inContainer: false,
      });
      expect(cloud.registered[0]).toMatch(
        /^https:\/\/gw-[0-9a-z]{8}\.eu\.relay\.test\/mcp$/,
      );
      const served = await serveThroughRelay(configPath, env);
      expect(served.health).toEqual({ status: 200, body: "ok" });
      expect(relay.tokens.length).toBeGreaterThan(0);
      expect(forged.tokens).toEqual([]);
      expect(forged.idle()).toBe(0);
    } finally {
      await forged.close();
    }
  });
});
