// Unit coverage for lib/ee-plugins.ts — the open-core seam that lets the ee
// build contribute Better Auth plugins (SSO) into the sync createAuth() without
// core ever importing ee/. The registry is the neutral handoff: ee registers at
// boot; createAuth() reads synchronously.

import { afterEach, describe, expect, it } from "vitest";

import type { BetterAuthPlugin } from "better-auth";

import {
  getEeAuthPlugins,
  registerEeAuthPlugins,
} from "../src/lib/ee-plugins.ts";

// Minimal stand-ins — the registry is plugin-agnostic; it just holds the array.
const fake = (id: string): BetterAuthPlugin => ({ id }) as BetterAuthPlugin;

describe("ee auth plugin registry", () => {
  afterEach(() => registerEeAuthPlugins([]));

  it("is empty by default — a keyless build splices nothing", () => {
    registerEeAuthPlugins([]);
    expect(getEeAuthPlugins()).toEqual([]);
  });

  it("returns what the ee bootstrap registered", () => {
    const plugins = [fake("sso")];
    registerEeAuthPlugins(plugins);
    expect(getEeAuthPlugins()).toBe(plugins);
  });

  it("replaces (not appends) on re-register — idempotent across a dev hot-reload", () => {
    registerEeAuthPlugins([fake("sso")]);
    registerEeAuthPlugins([fake("a"), fake("b")]);
    expect(getEeAuthPlugins().map((p) => p.id)).toEqual(["a", "b"]);
  });
});
