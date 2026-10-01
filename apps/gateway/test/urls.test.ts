// The URLs a gateway answers on: which are audiences, which host names it
// answers to, and which URL its metadata names for a request's Host.

import { describe, expect, it } from "vitest";
import { PublicUrls } from "../src/urls.ts";

const direct = "https://db.example.com/mcp";
const tunnel = "https://midplane.abc123.tunnel.example.com/mcp";
const pending = "https://ingress.example.com/mcp";

describe("a gateway's URLs", () => {
  it("in local mode, are what its config names", () => {
    const urls = new PublicUrls({ configured: [direct, tunnel] });
    expect(urls.audiences()).toEqual([direct, tunnel]);
    expect(urls.hostnames().sort()).toEqual([
      "db.example.com",
      "midplane.abc123.tunnel.example.com",
    ]);
    expect(urls.resourceFor("midplane.abc123.tunnel.example.com")).toBe(tunnel);
    expect(urls.resourceFor("db.example.com:443")).toBe(direct);
    expect(urls.resourceFor(undefined)).toBe(direct);
  });

  it("once linked, are what the bundle registers", () => {
    const urls = new PublicUrls({ configured: [pending, direct] });
    urls.register([direct, tunnel]);
    expect(urls.audiences()).toEqual([direct, tunnel]);
    expect(urls.unregistered()).toEqual([pending]);
    // Its own configured name is still answered, but the metadata never
    // names a URL whose tokens it would refuse.
    expect(urls.hostnames()).toContain("ingress.example.com");
    expect(urls.resourceFor("ingress.example.com")).toBe(direct);
    expect(urls.resourceFor("midplane.abc123.tunnel.example.com")).toBe(tunnel);
  });

  it("answer to loopback names on a loopback listener, and to allowed hosts", () => {
    const urls = new PublicUrls({
      configured: [tunnel],
      allowedHosts: ["Midplane-Gateway"],
      loopback: true,
    });
    expect(urls.hostnames()).toEqual(
      expect.arrayContaining([
        "midplane-gateway",
        "localhost",
        "127.0.0.1",
        "[::1]",
      ]),
    );
    // A proxy that rewrites Host: the first URL stands in.
    expect(urls.resourceFor("127.0.0.1:7433")).toBe(tunnel);
    expect(urls.resourceFor("midplane-gateway:7433")).toBe(tunnel);
    expect(new PublicUrls({ configured: [tunnel] }).hostnames()).not.toContain(
      "localhost",
    );
  });
});
