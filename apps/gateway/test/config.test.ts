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
});
