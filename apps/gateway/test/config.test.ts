import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSigningKey } from "../src/auth.ts";
import { ConfigError, parseConfig, parseLinkedConfig } from "../src/config.ts";

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "midplane-config-"));
  const { publicJwk } = await generateSigningKey();
  writeFileSync(join(dir, "verify.json"), JSON.stringify(publicJwk));
});

const env = { DSN: "postgres://u@localhost/db", SALT: "x".repeat(32) };

function config(
  overrides: Record<string, unknown> = {},
  e: Record<string, string> = env,
) {
  const doc = {
    auth: { issuer: "local", public_key_file: "verify.json" },
    audit: { file: "audit.db" },
    mask_salt: { env: "SALT" },
    databases: {
      main: {
        dsn: { env: "DSN" },
        policy: { table_access: { default: "read" } },
      },
    },
    ...overrides,
  };
  return parseConfig(JSON.stringify(doc), join(dir, "midplane.yaml"), e);
}

describe("local config", () => {
  it("resolves secrets and paths, and validates each policy", () => {
    const c = config();
    expect(c.databases.get("main")?.dsn).toBe(env.DSN);
    expect(c.databases.get("main")?.policy.table_access.default).toBe("read");
    expect(c.auditFile).toBe(join(dir, "audit.db"));
    expect(c.listen).toEqual({ host: "127.0.0.1", port: 7433 });
  });

  it("keeps audit events 30 days by default; 0 keeps everything", () => {
    expect(config().auditRetentionDays).toBe(30);
    expect(
      config({ audit: { file: "audit.db", retention_days: 0 } })
        .auditRetentionDays,
    ).toBe(0);
    expect(() =>
      config({ audit: { file: "audit.db", retention_days: -1 } }),
    ).toThrow(ConfigError);
  });

  it("requires TLS off loopback", () => {
    expect(() => config({ listen: { host: "0.0.0.0", port: 7433 } })).toThrow(
      /tls is required/,
    );
  });

  it("takes several public URLs, or one, and more host names", () => {
    expect(config().publicUrls).toEqual([]);
    const c = config({
      public_urls: [
        "https://db.example.com/",
        "https://db.abc123.tunnel.example.com",
      ],
      listen: { allowed_hosts: ["midplane-gateway", "mcp_upstream"] },
    });
    expect(c.publicUrls).toEqual([
      "https://db.example.com",
      "https://db.abc123.tunnel.example.com",
    ]);
    expect(c.allowedHosts).toEqual(["midplane-gateway", "mcp_upstream"]);
    expect(c.listen).toEqual({ host: "127.0.0.1", port: 7433 });
    // Written as the cloud registers it: lowercase host, no default port.
    expect(
      config({ public_url: "https://DB.Example.com:443/gw/" }).publicUrls,
    ).toEqual(["https://db.example.com/gw"]);
  });

  it("refuses public URLs it couldn't answer on", () => {
    for (const bad of [
      { public_url: "https://a.example", public_urls: ["https://b.example"] },
      { public_urls: ["https://a.example", "https://a.example/"] },
      { public_urls: [] },
      { public_urls: ["ftp://a.example"] },
      { public_urls: ["https://user:pw@a.example"] },
      { public_urls: ["https://a.example/?x=1"] },
      { listen: { allowed_hosts: ["a.example:443"] } },
    ]) {
      expect(() => config(bad), JSON.stringify(bad)).toThrow(ConfigError);
    }
  });

  it("needs public URLs to listen on every interface", () => {
    const tls = { cert_file: "verify.json", key_file: "verify.json" };
    expect(() => config({ listen: { host: "0.0.0.0" }, tls })).toThrow(
      /public_urls/,
    );
    expect(
      config({
        listen: { host: "0.0.0.0" },
        tls,
        public_url: "https://db.example.com",
      }).publicUrls,
    ).toEqual(["https://db.example.com"]);
  });

  // protects=`tls: { acme: {} }` gets Let's Encrypt, port 7480 and the config's acme/ folder, for the one https host;
  // fails_when=a default changes, the names aren't the URL's host, or the folder isn't beside the config;
  // no_claim=that Let's Encrypt can reach the host (the gateway finds out at start)
  it("takes tls.acme with defaults, certifying the public URL's host", () => {
    const c = config({
      listen: { host: "0.0.0.0" },
      public_urls: ["https://GW.example.com:8443"],
      tls: { acme: {} },
    });
    expect(c.tls).toEqual({
      kind: "acme",
      names: ["gw.example.com"],
      httpPort: 7480,
      directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
      dir: join(dir, "acme"),
    });
    expect(
      config({
        public_urls: ["https://gw.example.com", "https://gw.example.com/b"],
        tls: {
          acme: {
            http_port: 8080,
            directory_url: "http://127.0.0.1:14000/dir",
          },
        },
      }).tls,
    ).toMatchObject({
      names: ["gw.example.com"],
      httpPort: 8080,
      directoryUrl: "http://127.0.0.1:14000/dir",
    });
  });

  // protects=a certificate comes from files or from ACME, never a mix of the two;
  // fails_when=acme with cert_file or key_file, or a lone cert_file, is accepted;
  // no_claim=nothing about the files' contents
  it("refuses tls.acme with certificate files, and half a pair of files", () => {
    const url = { public_url: "https://gw.example.com" };
    for (const tls of [
      { acme: {}, cert_file: "verify.json" },
      { acme: {}, key_file: "verify.json" },
      { cert_file: "verify.json" },
      {},
      { acme: { http_port: 7480, extra: 1 } },
    ]) {
      expect(() => config({ ...url, tls }), JSON.stringify(tls)).toThrow(
        ConfigError,
      );
    }
    expect(() =>
      config({ ...url, tls: { acme: {}, cert_file: "verify.json" } }),
    ).toThrow("tls takes cert_file and key_file, or acme, not both");
    for (const tls of [{ cert_file: "verify.json" }, {}]) {
      expect(() => config({ ...url, tls }), JSON.stringify(tls)).toThrow(
        "tls needs cert_file and key_file, or acme",
      );
    }
  });

  // protects=ACME certifies one host name, the gateway's own, which Let's Encrypt can reach on port 80;
  // fails_when=an IP address, no https URL, two hosts, an http directory off this machine or a clash with listen.port is accepted;
  // no_claim=that DNS for the name points here
  it("needs tls.acme to certify one host name", () => {
    const acme = (more: Record<string, unknown>) => () =>
      config({ tls: { acme: {} }, ...more });
    expect(acme({ public_url: "https://192.0.2.10" })).toThrow(
      "tls.acme: an automatic certificate needs a host name, not an IP address",
    );
    expect(acme({ public_url: "https://[2001:db8::1]" })).toThrow(
      /needs a host name/,
    );
    expect(acme({})).toThrow(
      "tls.acme needs public_urls to name one https host to certify",
    );
    expect(acme({ public_url: "http://gw.example.com" })).toThrow(
      /one https host/,
    );
    expect(
      acme({ public_urls: ["https://a.example.com", "https://b.example.com"] }),
    ).toThrow(
      "tls.acme needs public_urls to name one https host to certify, not 2",
    );
    expect(() =>
      config({
        public_url: "https://gw.example.com",
        tls: { acme: { directory_url: "http://acme.example.com/dir" } },
      }),
    ).toThrow(/directory_url must use https/);
    expect(() =>
      config({
        public_url: "https://gw.example.com",
        listen: { port: 7480 },
        tls: { acme: {} },
      }),
    ).toThrow(/http_port must differ from listen.port/);
  });

  it("names a certificate file it can't read", () => {
    expect(() =>
      config({ tls: { cert_file: "missing.crt", key_file: "verify.json" } }),
    ).toThrow(
      `tls.cert_file: cannot read ${join(dir, "missing.crt")} (ENOENT)`,
    );
  });

  it("requires a salt of at least 32 characters when a database has masks", () => {
    const masked = {
      databases: {
        main: {
          dsn: { env: "DSN" },
          policy: { masks: { "public.users": { email: "full-redact" } } },
        },
      },
    };
    expect(() => config({ ...masked, mask_salt: undefined })).toThrow(
      /mask_salt is required/,
    );
    expect(() => config(masked, { ...env, SALT: "short" })).toThrow(
      /at least 32/,
    );
    expect(config(masked).maskSalt).toBe(env.SALT);
  });

  it("refuses a policy the core can't enforce", () => {
    expect(() =>
      config({
        databases: {
          main: { dsn: { env: "DSN" }, policy: { tenant_scope: {} } },
        },
      }),
    ).toThrow(ConfigError);
    expect(() =>
      config({
        databases: {
          main: {
            dsn: { env: "DSN" },
            policy: { requires_features: ["row_filters"] },
          },
        },
      }),
    ).toThrow(/lacks: row_filters/);
  });

  it("names a missing secret", () => {
    expect(() => config({}, { SALT: env.SALT })).toThrow(/DSN is not set/);
  });

  it("rejects unknown keys", () => {
    expect(() => config({ databse: {} })).toThrow(ConfigError);
  });
});

describe("linked config", () => {
  function linked(
    link: Record<string, unknown> = {},
    databases: Record<string, unknown> = { main: { dsn: { env: "DSN" } } },
    e: Record<string, string> = env,
  ) {
    const doc = {
      audit: { file: "audit.db" },
      link: {
        cloud_url: "https://cloud.example.com/some/path",
        identity: { file: "identity.json" },
        ...link,
      },
      databases,
    };
    return parseLinkedConfig(JSON.stringify(doc), join(dir, "gw.yaml"), e);
  }

  it("names the cloud by origin and resolves the identity and cache paths", () => {
    const c = linked();
    expect(c.link.cloudUrl).toBe("https://cloud.example.com");
    expect(c.link.identity).toEqual({
      kind: "file",
      path: join(dir, "identity.json"),
    });
    expect(c.link.bundleCache).toBe(join(dir, "bundle.jws"));
    expect(c.databases.get("main")?.dsn).toBe(env.DSN);
  });

  it("takes an identity from the environment", () => {
    const c = linked({ identity: { env: "ID" } }, undefined, {
      ...env,
      ID: "{}",
    });
    expect(c.link.identity).toEqual({ kind: "env", name: "ID", value: "{}" });
  });

  it("reads the enrollment token only when asked, and says when there is none", () => {
    expect(() => linked().link.enrollmentToken()).toThrow(/enrollment_token/);
    const c = linked({ enrollment_token: { env: "TOKEN" } }, undefined, {
      ...env,
      TOKEN: "mpe1_x",
    });
    expect(c.link.enrollmentToken()).toBe("mpe1_x");
  });

  it("takes no policies: they arrive in bundles", () => {
    expect(() =>
      linked(undefined, {
        main: { dsn: { env: "DSN" }, policy: { table_access: {} } },
      }),
    ).toThrow(ConfigError);
  });

  it("requires https to reach the cloud off this machine", () => {
    expect(() => linked({ cloud_url: "http://cloud.example.com" })).toThrow(
      /https/,
    );
    expect(linked({ cloud_url: "http://localhost:3900" }).link.cloudUrl).toBe(
      "http://localhost:3900",
    );
  });

  // protects=a relayed gateway's config: one https relay URL under the control name's domain, a certificate from ACME through the relay with no port bound, and a loopback listener; each other shape is refused naming its key, and local mode refuses `relay`;
  // fails_when=a vanity, foreign, http, ported or pathed URL, a second URL, certificate files, an http_port, an off-loopback listener or a control name not `relay.<domain>` is accepted, or a relayed config gets a challenge port;
  // no_claim=that the relay accepts this gateway, or that the cloud registered its URL (both at run time)
  it("takes relay with one relay URL, a certificate through it and a loopback listener", () => {
    const relayed = (over: Record<string, unknown> = {}) =>
      parseLinkedConfig(
        JSON.stringify({
          listen: { host: "127.0.0.1", port: 7433 },
          relay: { control: "relay.eu.midplane.app" },
          public_url: "https://gw-k3m9x2qa.eu.midplane.app",
          tls: { acme: {} },
          audit: { file: "audit.db" },
          link: {
            cloud_url: "https://cloud.example.com",
            identity: { file: "identity.json" },
          },
          databases: { main: { dsn: { env: "DSN" } } },
          ...over,
        }),
        join(dir, "gw.yaml"),
        env,
      );
    const c = relayed();
    expect(c.relay).toEqual({
      control: "relay.eu.midplane.app",
      domain: "eu.midplane.app",
    });
    expect(c.publicUrls).toEqual(["https://gw-k3m9x2qa.eu.midplane.app"]);
    expect(c.tls).toMatchObject({
      kind: "acme",
      names: ["gw-k3m9x2qa.eu.midplane.app"],
      httpPort: null,
    });
    // A direct gateway's ACME still binds its challenge port.
    expect(linked().relay).toBeNull();

    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ relay: { control: "eu.midplane.app" } }, /^relay\.control /],
      [{ relay: { control: "relay." } }, /^relay\.control /],
      [{ public_url: "https://db.example.com" }, /^public_url must/],
      [{ public_url: "https://mcp.eu.midplane.app" }, /^public_url must/],
      [{ public_url: "https://gw-k3m9x2qa.us.midplane.app" }, /^public_url/],
      [{ public_url: "http://gw-k3m9x2qa.eu.midplane.app" }, /^public_url/],
      [
        { public_url: "https://gw-k3m9x2qa.eu.midplane.app:8443" },
        /^public_url/,
      ],
      [{ public_url: "https://gw-k3m9x2qa.eu.midplane.app/x" }, /^public_url/],
      [{ public_url: "https://gw-k3m9x2qa.eu.midplane.app." }, /^public_url/],
      [{ public_url: "https://relay.eu.midplane.app" }, /^public_url/],
      [
        {
          public_url: undefined,
          public_urls: [
            "https://gw-k3m9x2qa.eu.midplane.app",
            "https://db.example.com",
          ],
        },
        /^public_urls: .*one public URL/,
      ],
      [{ public_url: undefined }, /^public_url: .*one public URL/],
      [{ tls: undefined }, /^tls: /],
      [{ tls: { cert_file: "a.pem", key_file: "b.pem" } }, /^tls: /],
      [{ tls: { acme: { http_port: 7480 } } }, /^tls\.acme\.http_port: /],
      [
        { listen: { host: "0.0.0.0", port: 7433 } },
        /^listen\.host 0\.0\.0\.0: /,
      ],
    ];
    for (const [over, message] of refusals) {
      expect(() => relayed(over), JSON.stringify(over)).toThrow(ConfigError);
      expect(() => relayed(over), JSON.stringify(over)).toThrow(message);
    }

    expect(() =>
      config({ relay: { control: "relay.eu.midplane.app" } }),
    ).toThrow(/^relay: only a linked gateway/);
  });
});
