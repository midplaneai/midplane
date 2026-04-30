import { describe, expect, test } from "bun:test";
import { loadTelemetryConfig } from "../../src/telemetry/config.ts";

function env(o: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return o as NodeJS.ProcessEnv;
}

describe("telemetry config — mode resolution", () => {
  test("unset → enabled", () => {
    expect(loadTelemetryConfig(env({})).mode).toBe("enabled");
  });

  test("MIDPLANE_TELEMETRY=0/off/false → disabled", () => {
    for (const v of ["0", "off", "false", "no", "OFF"]) {
      expect(loadTelemetryConfig(env({ MIDPLANE_TELEMETRY: v })).mode).toBe("disabled");
    }
  });

  test("DO_NOT_TRACK=1 → disabled regardless of MIDPLANE_TELEMETRY", () => {
    expect(
      loadTelemetryConfig(env({ DO_NOT_TRACK: "1", MIDPLANE_TELEMETRY: "1" })).mode,
    ).toBe("disabled");
    expect(
      loadTelemetryConfig(env({ DO_NOT_TRACK: "true", MIDPLANE_TELEMETRY: "debug" })).mode,
    ).toBe("disabled");
  });

  test("MIDPLANE_TELEMETRY=debug → debug", () => {
    expect(loadTelemetryConfig(env({ MIDPLANE_TELEMETRY: "debug" })).mode).toBe("debug");
  });

  test("unknown value → disabled (fail safe)", () => {
    expect(loadTelemetryConfig(env({ MIDPLANE_TELEMETRY: "wat" })).mode).toBe("disabled");
  });

  test("endpoint defaults to t.midplane.ai/v1/events", () => {
    expect(loadTelemetryConfig(env({})).endpoint).toBe("https://t.midplane.ai/v1/events");
  });

  test("endpoint override honored", () => {
    expect(
      loadTelemetryConfig(env({ MIDPLANE_TELEMETRY_ENDPOINT: "https://example.com/x" })).endpoint,
    ).toBe("https://example.com/x");
  });

  test("heartbeat interval clamps invalid values back to default", () => {
    const def = loadTelemetryConfig(env({})).heartbeatMs;
    expect(loadTelemetryConfig(env({ MIDPLANE_TELEMETRY_HEARTBEAT_MS: "0" })).heartbeatMs).toBe(def);
    expect(loadTelemetryConfig(env({ MIDPLANE_TELEMETRY_HEARTBEAT_MS: "abc" })).heartbeatMs).toBe(def);
    expect(loadTelemetryConfig(env({ MIDPLANE_TELEMETRY_HEARTBEAT_MS: "5000" })).heartbeatMs).toBe(5000);
  });
});
