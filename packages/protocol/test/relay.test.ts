// The relay's wire format: the PROXY v1 line the relay writes before a
// stream and the gateway reads, and the host names the relay routes. Both
// ends read these from here, so a mismatch is a test failure, not an outage.

import { describe, expect, it } from "vitest";
import {
  GATEWAY_SLUG_ALPHABET,
  GatewaySlugSchema,
  PROXY_LINE_MAX,
  proxyLine,
  readProxyLine,
  relayControlName,
  relaySlugOf,
  underRelayDomain,
} from "../src/index.ts";

const bytes = (s: string) => Buffer.from(s, "latin1");

describe("the PROXY line", () => {
  // protects=a stream's header round-trips: the gateway reads the client's address and port, and the destination port that picks its server, from what the relay wrote, and knows where the stream's own bytes start;
  // fails_when=a field is lost or reordered, IPv6 is refused, or the length leaves the CRLF in front of the TLS bytes;
  // no_claim=that the addresses are the client's (the relay's tests)
  it("is read back as written, and says where the stream starts", () => {
    for (const h of [
      {
        family: "TCP4" as const,
        source: "203.0.113.7",
        destination: "10.0.0.2",
        sourcePort: 51234,
        destinationPort: 443,
      },
      {
        family: "TCP6" as const,
        source: "2001:db8::7",
        destination: "::",
        sourcePort: 1,
        destinationPort: 80,
      },
    ]) {
      const line = proxyLine(h);
      expect(line.endsWith("\r\n")).toBe(true);
      expect(line.length).toBeLessThanOrEqual(PROXY_LINE_MAX);
      const read = readProxyLine(bytes(`${line}\x16\x03\x01`));
      expect(read).toEqual({ header: h, length: line.length });
    }
    expect(readProxyLine(bytes("PROXY UNKNOWN\r\nrest"))).toEqual({
      header: null,
      length: 15,
    });
  });

  // protects=a line still arriving is waited for, and anything that isn't a well-formed line is refused rather than guessed at;
  // fails_when=a partial line is taken as invalid, TLS bytes or an HTTP request pass as a line, a line with no CRLF within 107 bytes is waited on forever, or a bad address, port or family is accepted;
  // no_claim=PROXY v2, which neither end speaks
  it("waits for its CRLF, and refuses anything else", () => {
    expect(readProxyLine(bytes(""))).toBe("more");
    expect(readProxyLine(bytes("PRO"))).toBe("more");
    expect(readProxyLine(bytes("PROXY TCP4 203.0.113.7 10.0.0.2 1"))).toBe(
      "more",
    );
    for (const bad of [
      "\x16\x03\x01\x02\x00",
      "GET / HTTP/1.1\r\n",
      `PROXY TCP4 ${"1".repeat(120)}`,
      "PROXY TCP4 203.0.113.7 10.0.0.2 1\r\n",
      "PROXY TCP4 203.0.113.700 10.0.0.2 1 443\r\n",
      "PROXY TCP4 2001:db8::7 10.0.0.2 1 443\r\n",
      "PROXY TCP6 203.0.113.7 :: 1 443\r\n",
      "PROXY TCP4 203.0.113.7 10.0.0.2 1 65536\r\n",
      "PROXY UDP4 203.0.113.7 10.0.0.2 1 443\r\n",
      "PROXY TCP4 203.0.113.7  10.0.0.2 1 443\r\n",
      "PROXY TCP4 203.0.113.7 10.0.0.2 1 44\x003\r\n",
    ]) {
      expect(readProxyLine(bytes(bad)), JSON.stringify(bad)).toBe("invalid");
    }
    expect(() =>
      proxyLine({
        family: "TCP4",
        source: "::1",
        destination: "10.0.0.2",
        sourcePort: 1,
        destinationPort: 443,
      }),
    ).toThrow();
  });
});

describe("relay host names", () => {
  // protects=the relay routes only `<gateway slug>.<domain>` names, with setup's alphabet, and its own control name is never a gateway's;
  // fails_when=a vanity label, a deeper name, the control name or a slug with i, l, o or u is taken for a gateway host, or a name merely ending in the domain's text counts as under it;
  // no_claim=that a host is registered (the cloud's lookup)
  it("are a gateway's slug under the relay domain", () => {
    const domain = "eu.midplane.app";
    expect(GATEWAY_SLUG_ALPHABET).toHaveLength(32);
    expect(relaySlugOf("gw-k3m9x2qa.eu.midplane.app", domain)).toBe(
      "gw-k3m9x2qa",
    );
    for (const host of [
      "acme.eu.midplane.app",
      "relay.eu.midplane.app",
      "x.gw-k3m9x2qa.eu.midplane.app",
      "gw-k3m9x2qi.eu.midplane.app",
      "gw-k3m9x2q.eu.midplane.app",
      "gw-k3m9x2qa.us.midplane.app",
      "gw-k3m9x2qaeu.midplane.app",
    ]) {
      expect(relaySlugOf(host, domain), host).toBeNull();
    }
    expect(GatewaySlugSchema.safeParse("gw-0123456z").success).toBe(true);
    expect(relayControlName(domain)).toBe("relay.eu.midplane.app");
    expect(underRelayDomain("eu.midplane.app", domain)).toBe(true);
    expect(underRelayDomain("acme.eu.midplane.app", domain)).toBe(true);
    expect(underRelayDomain("evileu.midplane.app", domain)).toBe(false);
  });
});
