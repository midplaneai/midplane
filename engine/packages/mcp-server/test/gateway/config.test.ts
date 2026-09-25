// `midplane gateway` configuration: what it refuses to boot with.

import { describe, expect, test } from "bun:test";
import {
  GatewayConfigError,
  isLoopbackAddress,
  loadGatewayConfig,
  parseCloudUrl,
} from "../../src/gateway/config.ts";

const BASE = {
  MIDPLANE_CLOUD_URL: "https://eu.app.midplane.ai",
  MIDPLANE_MASK_SALT: "0123456789abcdef0123456789abcdef",
  MIDPLANE_GATEWAY_STATE_DIR: "/tmp/midplane-gw-test-state",
};

function problems(env: NodeJS.ProcessEnv): string[] {
  try {
    loadGatewayConfig(env);
  } catch (err) {
    if (err instanceof GatewayConfigError) return err.problems;
    throw err;
  }
  return [];
}

describe("loadGatewayConfig", () => {
  test("minimal valid config: HTTP on 127.0.0.1, salt passed to the engine", () => {
    const cfg = loadGatewayConfig({ ...BASE, MIDPLANE_ENROLL_TOKEN: " mpe1_abc \n" });
    expect(cfg.cloudUrl).toBe("https://eu.app.midplane.ai");
    expect(cfg.enrollToken).toBe("mpe1_abc");
    expect(cfg.stateDir).toBe("/tmp/midplane-gw-test-state");
    expect(cfg.pollSeconds).toBeNull();
    expect(cfg.engine).toMatchObject({ host: "127.0.0.1", port: 8080, transport: "http", maskSalt: BASE.MIDPLANE_MASK_SALT });
  });

  describe("non-loopback binds are refused", () => {
    test.each(["0.0.0.0", "::", "10.0.0.5", "192.168.1.20", "localhost", "[::1]", "::ffff:127.0.0.1", "example.com"])(
      "MIDPLANE_HOST=%s",
      (host) => {
        expect(problems({ ...BASE, MIDPLANE_HOST: host }).join("\n")).toContain("not a loopback address");
      },
    );
    test.each(["127.0.0.1", "127.0.0.2", "::1", "0:0:0:0:0:0:0:1"])("MIDPLANE_HOST=%s is accepted", (host) => {
      expect(loadGatewayConfig({ ...BASE, MIDPLANE_HOST: host }).engine.host).toBe(host);
    });
  });

  test.each(["MIDPLANE_POLICY_FILE", "DATABASE_URL", "INDEXER_TOKEN", "MIDPLANE_APPROVAL_URL", "MIDPLANE_APPROVAL_TOKEN"])(
    "%s is refused: a gateway has one policy source and one credential channel",
    (name) => {
      expect(problems({ ...BASE, [name]: "x" }).join("\n")).toContain(`${name} is set`);
    },
  );

  test("stdio transport is refused", () => {
    expect(problems({ ...BASE, MIDPLANE_TRANSPORT: "stdio" }).join("\n")).toContain("HTTP only");
  });

  test("the salt is required at boot, before any mask exists, and must be long enough", () => {
    expect(problems({ ...BASE, MIDPLANE_MASK_SALT: undefined }).join("\n")).toContain("MIDPLANE_MASK_SALT");
    expect(problems({ ...BASE, MIDPLANE_MASK_SALT: "short" }).join("\n")).toContain("at least 32");
  });

  test("the cloud URL is required", () => {
    expect(problems({ ...BASE, MIDPLANE_CLOUD_URL: undefined }).join("\n")).toContain("MIDPLANE_CLOUD_URL is required");
  });

  test("poll interval has a floor", () => {
    expect(problems({ ...BASE, MIDPLANE_GATEWAY_POLL_SECONDS: "1" }).join("\n")).toContain("≥ 5");
    expect(loadGatewayConfig({ ...BASE, MIDPLANE_GATEWAY_POLL_SECONDS: "30" }).pollSeconds).toBe(30);
  });

  test("every problem is reported at once", () => {
    const p = problems({ DATABASE_URL: "x", MIDPLANE_HOST: "0.0.0.0" });
    expect(p.length).toBeGreaterThanOrEqual(4); // DATABASE_URL, cloud URL, salt, host
  });
});

describe("parseCloudUrl", () => {
  test("an https origin", () => {
    expect(parseCloudUrl("https://eu.app.midplane.ai/")).toBe("https://eu.app.midplane.ai");
  });
  test("plain http only to this machine", () => {
    expect(parseCloudUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parseCloudUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(() => parseCloudUrl("http://eu.app.midplane.ai")).toThrow(/https/);
  });
  test("origin only: no path, query or credentials", () => {
    for (const bad of ["https://eu.app.midplane.ai/api", "https://eu.app.midplane.ai/?x=1", "https://u:p@eu.app.midplane.ai", "not a url"]) {
      expect(() => parseCloudUrl(bad)).toThrow();
    }
  });
});

describe("isLoopbackAddress", () => {
  test("literal loopback addresses only", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.255.255.254")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("128.0.0.1")).toBe(false);
    expect(isLoopbackAddress("localhost")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });
});
