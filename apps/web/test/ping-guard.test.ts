// SSRF-guard coverage for the shared ping path. Three layers:
//
//   isBlockedAddress — the address-space matrix (the part that MUST
//     fail closed: a miss here is a dial into the private network).
//   vetDsnHost       — DSN parsing + the all-records rule (a resolver
//     answering [public, private] is the rebinding shape).
//   pingDsnGuarded   — wiring: blocked hosts never reach the driver
//     (poisoned ping fn proves no dial), vetted hostnames dial the
//     pinned IP with SNI preserved, IP-literal DSNs dial as-is, and
//     the guard is bypassed when disabled (local dev).
//
// The injected `env` keeps the suite independent of NODE_ENV.

import { describe, expect, it, vi } from "vitest";

import {
  GENERIC_PING_ERROR,
  isBlockedAddress,
  pingDsnGuarded,
  pingGuardEnabled,
  vetDsnHost,
} from "../src/lib/ping-guard.ts";

const GUARD_ON = { PING_GUARD: "on" };

function lookupReturning(addresses: string[]) {
  return vi.fn(async () =>
    addresses.map((address) => ({ address, family: 4 })),
  ) as never;
}

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "0.0.0.0",
    "198.18.0.1", // benchmarking
    "224.0.0.1", // multicast
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fdaa:0:1::1", // Fly 6PN
    "fe80::1",
    "::ffff:10.0.0.1", // mapped v4, private
    "::ffff:127.0.0.1",
    "not-an-ip", // fail closed
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255", // just below 172.16/12
    "172.32.0.1", // just above
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above
    "198.17.255.255",
    "198.20.0.1",
    "2606:4700::1111", // public v6
    "::ffff:8.8.8.8", // mapped v4, public
  ])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("vetDsnHost", () => {
  it("vets a hostname whose records are all public", async () => {
    const lookup = lookupReturning(["52.10.0.5", "52.10.0.6"]);
    const result = await vetDsnHost("postgres://u:p@db.example.com:5432/app", {
      lookup,
    });
    expect(result).toEqual({
      ok: true,
      hostname: "db.example.com",
      address: "52.10.0.5",
    });
  });

  it("rejects when ANY resolved record is private (rebinding / split-horizon)", async () => {
    const lookup = lookupReturning(["52.10.0.5", "10.0.0.7"]);
    const result = await vetDsnHost("postgres://u:p@db.example.com/app", {
      lookup,
    });
    expect(result).toEqual({ ok: false });
  });

  it("vets IP-literal hosts without DNS (no address pin needed)", async () => {
    const lookup = vi.fn() as never;
    const ok = await vetDsnHost("postgres://u:p@52.10.0.5:5432/app", {
      lookup,
    });
    expect(ok).toEqual({ ok: true, hostname: "52.10.0.5", address: null });
    expect(lookup).not.toHaveBeenCalled();

    const blocked = await vetDsnHost("postgres://u:p@127.0.0.1/app", {
      lookup,
    });
    expect(blocked).toEqual({ ok: false });
  });

  it("rejects unresolvable hosts and unparseable DSNs", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    }) as never;
    expect(
      await vetDsnHost("postgres://u:p@nope.invalid/app", { lookup }),
    ).toEqual({ ok: false });
    expect(await vetDsnHost("not a url", { lookup })).toEqual({ ok: false });
  });
});

describe("pingDsnGuarded", () => {
  it("never dials a blocked host — poisoned ping proves it", async () => {
    const ping = vi.fn(async () => {
      throw new Error("guard failed: the driver was reached");
    }) as never;
    const lookup = lookupReturning(["10.0.0.7"]);
    const result = await pingDsnGuarded("postgres://u:p@internal.corp/app", {
      ping,
      lookup,
      env: GUARD_ON,
    });
    expect(result).toEqual({ ok: false, error: GENERIC_PING_ERROR });
    expect(ping).not.toHaveBeenCalled();
  });

  it("dials the vetted IP with SNI pinned to the hostname for TLS DSNs", async () => {
    const ping = vi.fn(async () => ({ ok: true })) as never;
    const lookup = lookupReturning(["52.10.0.5"]);
    const dsn = "postgres://u:p@ep.neon.tech/app?sslmode=require";
    const result = await pingDsnGuarded(dsn, { ping, lookup, env: GUARD_ON });
    expect(result).toEqual({ ok: true });
    expect(ping).toHaveBeenCalledWith(dsn, {
      hostOverride: "52.10.0.5",
      tlsServername: "ep.neon.tech",
    });
  });

  it("omits SNI for plain-TCP DSNs (forcing ssl would break the probe)", async () => {
    const ping = vi.fn(async () => ({ ok: true })) as never;
    const lookup = lookupReturning(["52.10.0.5"]);
    const dsn = "postgres://u:p@db.example.com/app";
    await pingDsnGuarded(dsn, { ping, lookup, env: GUARD_ON });
    expect(ping).toHaveBeenCalledWith(dsn, {
      hostOverride: "52.10.0.5",
      tlsServername: undefined,
    });
  });

  it("opportunistic TLS (sslmode=prefer/allow) is not forced into mandatory TLS", async () => {
    // Injecting an ssl object would turn prefer/allow into require —
    // public plain-TCP servers the DSN accepts would fail the probe.
    const ping = vi.fn(async () => ({ ok: true })) as never;
    for (const mode of ["prefer", "allow"]) {
      await pingDsnGuarded(
        `postgres://u:p@db.example.com/app?sslmode=${mode}`,
        { ping, lookup: lookupReturning(["52.10.0.5"]), env: GUARD_ON },
      );
      expect(ping).toHaveBeenLastCalledWith(expect.any(String), {
        hostOverride: "52.10.0.5",
        tlsServername: undefined,
      });
    }
  });

  it("sslmode=disable omits SNI; ssl=true pins it", async () => {
    const ping = vi.fn(async () => ({ ok: true })) as never;
    const lookup = lookupReturning(["52.10.0.5"]);
    await pingDsnGuarded("postgres://u:p@db.example.com/app?sslmode=disable", {
      ping,
      lookup,
      env: GUARD_ON,
    });
    expect(ping).toHaveBeenLastCalledWith(expect.any(String), {
      hostOverride: "52.10.0.5",
      tlsServername: undefined,
    });
    await pingDsnGuarded("postgres://u:p@db.example.com/app?ssl=true", {
      ping,
      lookup: lookupReturning(["52.10.0.5"]),
      env: GUARD_ON,
    });
    expect(ping).toHaveBeenLastCalledWith(expect.any(String), {
      hostOverride: "52.10.0.5",
      tlsServername: "db.example.com",
    });
  });

  it("fails closed when the resolver answers with zero records", async () => {
    const ping = vi.fn() as never;
    const lookup = lookupReturning([]);
    const result = await pingDsnGuarded("postgres://u:p@db.example.com/app", {
      ping,
      lookup,
      env: GUARD_ON,
    });
    expect(result).toEqual({ ok: false, error: GENERIC_PING_ERROR });
    expect(ping).not.toHaveBeenCalled();
  });

  it("dials IP-literal DSNs as-is once vetted", async () => {
    const ping = vi.fn(async () => ({ ok: true })) as never;
    const dsn = "postgres://u:p@52.10.0.5/app";
    await pingDsnGuarded(dsn, { ping, env: GUARD_ON });
    expect(ping).toHaveBeenCalledWith(dsn);
  });

  it("bypasses vetting entirely when the guard is off (local dev)", async () => {
    const ping = vi.fn(async () => ({ ok: true })) as never;
    const lookup = vi.fn() as never;
    const dsn = "postgres://u:p@localhost/app";
    await pingDsnGuarded(dsn, { ping, lookup, env: { PING_GUARD: "off" } });
    expect(ping).toHaveBeenCalledWith(dsn);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("pingGuardEnabled", () => {
  it("explicit value wins; default follows NODE_ENV", () => {
    expect(pingGuardEnabled({ PING_GUARD: "on" })).toBe(true);
    expect(pingGuardEnabled({ PING_GUARD: "off", NODE_ENV: "production" })).toBe(
      false,
    );
    expect(pingGuardEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(pingGuardEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(pingGuardEnabled({})).toBe(false);
  });

  it("defaults OFF in self-host (single-tenant, in-network DSN), but honors PING_GUARD=on", () => {
    // Self-host sets NODE_ENV=production; without the self-host branch the guard
    // would be ON and block the in-network postgres:5432 DSN the engine reaches.
    expect(
      pingGuardEnabled({ MIDPLANE_SELF_HOST: "1", NODE_ENV: "production" }),
    ).toBe(false);
    // An operator can still opt back in explicitly.
    expect(
      pingGuardEnabled({ MIDPLANE_SELF_HOST: "1", PING_GUARD: "on" }),
    ).toBe(true);
  });
});
