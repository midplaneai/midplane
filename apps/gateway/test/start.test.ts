// `midplane start` before it serves: what it starts from (a mounted config,
// the volume's, the environment, or nothing), and the environment it sets a
// gateway up from, refused before anything is written and without saying a
// connection string.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseLinkedConfig } from "../src/config.ts";
import { SetupError, setupYaml } from "../src/setup.ts";
import { chooseStart, readSetupEnv, setupFromEnv } from "../src/start.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TOKEN = `mpe1_${"A".repeat(86)}`;
const SHOP = "postgres://agent:pw-shop-7f3a@db.internal:5432/shop";
const BILLING = "postgres://agent:pw-billing-9c1e@db.internal:5432/billing";

/** Everything setup needs from the environment. */
const complete = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MIDPLANE_CLOUD_URL: "https://eu.app.midplane.ai",
  MIDPLANE_ENROLLMENT_TOKEN: TOKEN,
  MIDPLANE_URL: "https://midplane.example.com",
  MIDPLANE_DSN_SHOP: SHOP,
  ...more,
});

/** What readSetupEnv says when it refuses `env`. */
const refusal = (env: NodeJS.ProcessEnv) => {
  try {
    readSetupEnv(env, "/var/lib/midplane");
  } catch (err) {
    expect(err).toBeInstanceOf(SetupError);
    return (err as Error).message;
  }
  throw new Error("read");
};

describe("the environment", () => {
  // protects=each MIDPLANE_DSN_<ID> becomes database <id>, its variable kept for the config, and the rest becomes setup's flags with an automatic certificate;
  // fails_when=an id keeps its case, a variable is lost or misnamed, the config writes the connection string or a file for it, or the certificate isn't automatic;
  // no_claim=that the connection strings connect (setup tests them; the integration tests)
  it("names each database after its variable, and the config names the variable", () => {
    const { flags, databases } = readSetupEnv(
      complete({
        MIDPLANE_DSN_BILLING_EU: BILLING,
        MIDPLANE_PORT: "8443",
        MIDPLANE_ACME_DIRECTORY: "https://localhost:14000/dir",
        OTHER: "ignored",
      }),
      "/var/lib/midplane",
    );
    expect(flags).toEqual({
      cloud: "https://eu.app.midplane.ai",
      token: TOKEN,
      url: "https://midplane.example.com",
      acme: true,
      "acme-directory": "https://localhost:14000/dir",
      port: "8443",
      dir: "/var/lib/midplane",
    });
    expect(databases).toEqual([
      { id: "billing_eu", variable: "MIDPLANE_DSN_BILLING_EU", dsn: BILLING },
      { id: "shop", variable: "MIDPLANE_DSN_SHOP", dsn: SHOP },
    ]);

    const dir = mkdtempSync(join(tmpdir(), "midplane-start-yaml-"));
    mkdirSync(join(dir, "secrets"));
    writeFileSync(join(dir, "secrets", "mask-salt"), "s".repeat(64));
    const text = setupYaml({
      cloudUrl: "https://eu.app.midplane.ai",
      name: "midplane.example.com",
      baseUrl: "https://midplane.example.com",
      port: 7433,
      tls: {
        kind: "acme",
        directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
        httpPort: 7480,
      },
      databases: databases.map((d) => d.id),
      dsnEnv: Object.fromEntries(databases.map((d) => [d.id, d.variable])),
      by: "`midplane start`, from the environment",
    });
    expect(text).not.toContain("pw-");
    expect(parseYaml(text).databases).toEqual({
      billing_eu: { dsn: { env: "MIDPLANE_DSN_BILLING_EU" } },
      shop: { dsn: { env: "MIDPLANE_DSN_SHOP" } },
    });
    const config = parseLinkedConfig(text, join(dir, "midplane.yaml"), {
      MIDPLANE_DSN_SHOP: SHOP,
      MIDPLANE_DSN_BILLING_EU: BILLING,
    });
    expect(config.databases.get("shop")?.dsn).toBe(SHOP);
    expect(config.databases.get("billing_eu")?.dsn).toBe(BILLING);
  });

  // protects=every variable setup needs is named when missing, before anything is written; an empty one counts as missing;
  // fails_when=a missing variable is found only later (after writing, or at enrollment), goes unnamed, or an empty value passes;
  // no_claim=that the values are valid (the next test, and planSetup's own tests)
  it("needs the cloud, the token, the URL and a connection string, and names each missing", () => {
    const { MIDPLANE_DSN_SHOP: _, ...noDsn } = complete();
    expect(refusal(noDsn)).toBe(
      "MIDPLANE_DSN_<ID> is not set: one per database, its connection string, such as MIDPLANE_DSN_SHOP for shop. Nothing was written, and the token is unused.",
    );
    expect(
      refusal({ MIDPLANE_ENROLLMENT_TOKEN: TOKEN, MIDPLANE_URL: " " }),
    ).toBe(
      [
        "MIDPLANE_CLOUD_URL is not set: Midplane Cloud's URL, such as https://eu.app.midplane.ai",
        "MIDPLANE_URL is not set: the URL agents reach the gateway at, such as https://midplane.example.com",
        "MIDPLANE_DSN_<ID> is not set: one per database, its connection string, such as MIDPLANE_DSN_SHOP for shop. Nothing was written, and the token is unused.",
      ].join("; "),
    );
    // Optional ones left empty, as an env file may, are unset.
    expect(
      readSetupEnv(
        complete({ MIDPLANE_PORT: "", MIDPLANE_ACME_DIRECTORY: "" }),
        "/v",
      ).flags,
    ).not.toHaveProperty("port");
  });

  // protects=a bad id, two variables for one id, or a value that isn't a connection string is refused by its variable's name, and the value never appears;
  // fails_when=one is accepted, the refusal holds the value, or a URL or port refusal names a flag the environment doesn't have;
  // no_claim=nothing about what the gateway logs later (the integration tests scan those)
  it("refuses bad names and values by the variable's name, never the value", async () => {
    const secret = "pw-never-shown";
    const bad = refusal(
      complete({
        MIDPLANE_DSN_1SHOP: SHOP,
        MIDPLANE_DSN_: SHOP,
        MIDPLANE_DSN_Shop: SHOP,
        MIDPLANE_DSN_EMPTY: "",
        MIDPLANE_DSN_MYSQL: `mysql://agent:${secret}@db.internal/shop`,
      }),
    );
    for (const part of [
      "MIDPLANE_DSN_: after MIDPLANE_DSN_ comes the database's id",
      "MIDPLANE_DSN_1SHOP: after MIDPLANE_DSN_ comes the database's id",
      "MIDPLANE_DSN_SHOP and MIDPLANE_DSN_Shop both name shop",
      "MIDPLANE_DSN_EMPTY is empty",
      "MIDPLANE_DSN_MYSQL isn't a connection string: postgres://<user>:<password>@<host>:5432/<database>",
    ]) {
      expect(bad).toContain(part);
    }
    expect(bad).not.toContain(secret);
    expect(bad).not.toContain("pw-shop");

    // Setup's own checks name the variables too, before touching the disk.
    const dir = join(mkdtempSync(join(tmpdir(), "midplane-start-env-")), "v");
    const say = (env: NodeJS.ProcessEnv) =>
      setupFromEnv(env, { dir, log: () => {}, inContainer: false });
    await expect(
      say(complete({ MIDPLANE_URL: "https://192.0.2.10" })),
    ).rejects.toThrow(
      "an automatic certificate needs a host name, and MIDPLANE_URL names an IP address",
    );
    await expect(
      say(complete({ MIDPLANE_URL: "http://gw.example.com" })),
    ).rejects.toThrow(
      "MIDPLANE_URL must start with https://: off this machine the gateway needs TLS",
    );
    await expect(say(complete({ MIDPLANE_PORT: "80a" }))).rejects.toThrow(
      "MIDPLANE_PORT must be a port number, 1 to 65535",
    );
    await expect(
      say(complete({ MIDPLANE_ENROLLMENT_TOKEN: "mpe1_short" })),
    ).rejects.toThrow(
      "MIDPLANE_ENROLLMENT_TOKEN is not a Midplane enrollment token (mpe1_…)",
    );
    await expect(
      say(complete({ MIDPLANE_CLOUD_URL: "http://eu.app.midplane.ai" })),
    ).rejects.toThrow(
      "MIDPLANE_CLOUD_URL must use https (http only on this machine)",
    );
    expect(existsSync(dir)).toBe(false);
  });
});

describe("what start starts from", () => {
  const place = () => {
    const base = mkdtempSync(join(tmpdir(), "midplane-start-"));
    const config = join(base, "etc", "midplane.yaml");
    const dir = join(base, "data");
    mkdirSync(join(base, "etc"));
    mkdirSync(dir);
    return { config, dir };
  };

  // protects=a mounted config is served as `gateway --config` served it, whatever the volume or the environment hold;
  // fails_when=a token in the environment, or a volume's config, wins over a config the operator mounted;
  // no_claim=that the mounted config loads (the gateway's own checks)
  it("serves a mounted config first", () => {
    const { config, dir } = place();
    writeFileSync(config, "");
    writeFileSync(join(dir, "midplane.yaml"), "");
    expect(chooseStart({ config, dir, env: complete() })).toEqual({
      kind: "config",
      path: config,
    });
  });

  // protects=a volume set up before is served again, and the token in the environment isn't read twice;
  // fails_when=a restart sets up again (spending the token, or failing on the used one) instead of serving the volume;
  // no_claim=nothing about enrollment or the certificate on restart (the integration tests)
  it("serves the volume's config next, even with a token set", () => {
    const { config, dir } = place();
    writeFileSync(join(dir, "midplane.yaml"), "");
    expect(chooseStart({ config, dir, env: complete() })).toEqual({
      kind: "config",
      path: join(dir, "midplane.yaml"),
    });
  });

  // protects=with no config anywhere and a token in the environment, start sets up into the volume;
  // fails_when=it sets up somewhere else, or not at all;
  // no_claim=that the rest of the environment is complete (readSetupEnv's tests)
  it("sets up from the environment when it holds a token and nothing is set up", () => {
    const { config, dir } = place();
    expect(
      chooseStart({ config, dir, env: { MIDPLANE_ENROLLMENT_TOKEN: TOKEN } }),
    ).toEqual({ kind: "environment", dir });
  });

  // protects=with nothing to start from, start stops with the sentence that says both ways to give it one, as the process's last log line, exit 1;
  // fails_when=it serves nothing silently, exits 0, or an empty token counts as one;
  // no_claim=nothing about the image's paths (the package smoke runs the image)
  it("stops without a config or a token, saying how to give it one", () => {
    const { config, dir } = place();
    for (const env of [{}, { MIDPLANE_ENROLLMENT_TOKEN: " " }]) {
      expect(() => chooseStart({ config, dir, env })).toThrow(
        new SetupError(
          `no config: mount one at ${config}, or set MIDPLANE_ENROLLMENT_TOKEN from your project's setup page`,
        ),
      );
    }

    // As the command: exit 1, the sentence its last line; and with a token
    // but no connection string, the missing variable, with nothing written.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("MIDPLANE_")),
    );
    const lastLine = (r: ReturnType<typeof spawnSync>) =>
      JSON.parse(String(r.stderr).trim().split("\n").at(-1) ?? "{}");
    const args = [CLI, "start", "--config", config, "--dir", join(dir, "v")];
    const none = spawnSync(process.execPath, args, { env });
    expect(none.status).toBe(1);
    expect(lastLine(none)).toMatchObject({
      level: "error",
      msg: `no config: mount one at ${config}, or set MIDPLANE_ENROLLMENT_TOKEN from your project's setup page`,
    });
    const noDsn = spawnSync(process.execPath, args, {
      env: {
        ...env,
        MIDPLANE_CLOUD_URL: "https://eu.app.midplane.ai",
        MIDPLANE_ENROLLMENT_TOKEN: TOKEN,
        MIDPLANE_URL: "https://midplane.example.com",
      },
    });
    expect(noDsn.status).toBe(1);
    expect(lastLine(noDsn).msg).toMatch(/^MIDPLANE_DSN_<ID> is not set: /);
    expect(existsSync(join(dir, "v"))).toBe(false);
  });
});
