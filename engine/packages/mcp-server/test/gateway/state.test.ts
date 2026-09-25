// The gateway state directory.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayStateDir, type StoredIdentity } from "../../src/gateway/state.ts";

const IDENTITY: StoredIdentity = {
  v: 1,
  gateway_id: "01GATEWAY",
  project_id: "01PROJECT",
  cloud_url: "https://eu.app.midplane.test",
  issuer: "https://eu.app.midplane.test",
  gateway_key: "gwkey",
  signing_key: { kid: "abc", x: "def" },
  min_version: 3,
  poll_seconds: 15,
  enrolled_at: 1_790_000_000,
};

describe("GatewayStateDir", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "midplane-gw-state-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("creates the directory 0700 and the key 0600, once", () => {
    const state = GatewayStateDir.open(join(root, "gw"));
    expect(statSync(state.dir).mode & 0o777).toBe(0o700);
    const a = state.loadOrCreateKey();
    const b = state.loadOrCreateKey();
    expect(a.publicKeyRaw.equals(b.publicKeyRaw)).toBe(true);
    expect(statSync(state.keyPath).mode & 0o777).toBe(0o600);
  });

  test("two processes creating the key at once end up with the same key", () => {
    const state = GatewayStateDir.open(join(root, "gw"));
    const winner = state.loadOrCreateKey();
    // The loser checked before the winner wrote: it generates its own key, and
    // the exclusive link must hand it the winner's instead.
    const late = GatewayStateDir.open(join(root, "gw"));
    late.hasKey = () => false;
    expect(late.loadOrCreateKey().publicKeyRaw.equals(winner.publicKeyRaw)).toBe(true);
    expect(readdirSync(state.dir)).toEqual(["gateway.key"]);
  });

  test("identity and bundle round-trip; writes leave no temp files behind", () => {
    const state = GatewayStateDir.open(join(root, "gw"));
    expect(state.readIdentity()).toBeNull();
    expect(state.readBundle()).toBeNull();
    state.writeIdentity(IDENTITY);
    state.writeBundle("a.b.c");
    state.writeBundle("d.e.f");
    expect(state.readIdentity()).toEqual(IDENTITY);
    expect(state.readBundle()).toBe("d.e.f");
    expect(readdirSync(state.dir).sort()).toEqual(["bundle.jws", "identity.json"]);
  });

  test("a malformed identity is an error that says how to recover", () => {
    const state = GatewayStateDir.open(join(root, "gw"));
    writeFileSync(state.identityPath, JSON.stringify({ v: 1, gateway_id: "x" }));
    expect(() => state.readIdentity()).toThrow(/enroll again/);
    // Not JSON at all (a truncated write from another tool, a stray edit): same hint,
    // not a bare SyntaxError.
    writeFileSync(state.identityPath, "{ truncated");
    expect(() => state.readIdentity()).toThrow(/enroll again/);
  });
});
