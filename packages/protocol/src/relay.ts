// The relay: how agents reach a gateway that only connects out, at a host
// name Midplane assigns (`gw-<slug>.<region>.midplane.app`). The relay
// never decrypts agent traffic. A gateway opens TLS to the relay's control
// name and upgrades it to a work connection; when an agent connects with
// the gateway's host name as its SNI, the relay writes a PROXY protocol v1
// line naming the agent, then pipes the agent's still-encrypted bytes over
// one idle work connection, and TLS ends at the gateway.
//
// 1. `GET /v1/connect` on the control name, with the gateway's link access
//    token and `Upgrade: midplane-relay`; 101 makes it an idle work
//    connection. 401: the token, 403: no relay URL, 429: too many idle.
// 2. While idle the relay writes RELAY_PING every RELAY_PING_MS; the
//    gateway writes nothing, and drops one silent for RELAY_SILENCE_MS.
// 3. A stream starts with the PROXY line. Its destination port says what
//    follows: 443, TLS for the gateway's HTTPS server; 80, one ACME
//    challenge request, written by the relay, for its challenge listener.
//    A work connection carries one stream.

import { z } from "zod";
import { Ed25519PublicJwkSchema } from "./link.ts";

/** The work connection's upgrade, on the control name. */
export const RELAY_CONNECT_PATH = "/v1/connect";
export const RELAY_UPGRADE = "midplane-relay";

/** The relay's own host name is this label under the relay domain. */
export const RELAY_CONTROL_LABEL = "relay";

/** The byte an idle work connection hears, so neither end idles it out. */
export const RELAY_PING = 0x00;
export const RELAY_PING_MS = 25_000;
/** A gateway drops an idle work connection that has heard nothing this long. */
export const RELAY_SILENCE_MS = 75_000;

/** The most idle work connections one gateway may hold open. */
export const RELAY_MAX_IDLE = 8;

/** A stream's PROXY line names one of these as its destination port. */
export const RELAY_PORTS = { tls: 443, challenge: 80 } as const;

/**
 * The characters of a gateway's slug: Crockford's base32, lowercase, without
 * i, l, o or u, so a slug read aloud or typed is unambiguous.
 */
export const GATEWAY_SLUG_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
/** A gateway's slug, `gw-` and 8 of those: also its relay host's first label. */
export const GatewaySlugSchema = z
  .string()
  .regex(
    new RegExp(`^gw-[${GATEWAY_SLUG_ALPHABET}]{8}$`),
    "not a gateway slug",
  );

/** What a region's cloud says of its relay; it answers 404 without one. */
export const RelayInfoSchema = z.object({
  /** Gateway host names are `<slug>.<domain>`. */
  domain: z.string().min(1),
  /** Where gateways open work connections: `relay.<domain>`. */
  control: z.string().min(1),
});
export type RelayInfo = z.infer<typeof RelayInfoSchema>;

export const RELAY_JWS_TYPE = "mp-relay";

/**
 * Where the relay is, signed with the bundle key for the nonce setup sent
 * (`GET <link prefix>/relay?nonce=…`). Setup checks the key against its
 * enrollment token's pin before writing anything, so nothing between it
 * and the cloud can send the gateway's work connections, and its link
 * token, to another relay.
 */
export const RelayPayloadSchema = z.object({
  v: z.literal(1),
  /** The cloud's origin, as setup was given it. */
  iss: z.string().min(1),
  domain: z.string().min(1),
  control: z.string().min(1),
  nonce: z.string().min(1),
  iat: z.number().int(),
});
export type RelayPayload = z.infer<typeof RelayPayloadSchema>;

/**
 * The answer: where the relay is and, for a nonce, the same signed. Without
 * one, as older gateways ask, it is unsigned.
 */
export const RelayAnswerSchema = RelayInfoSchema.extend({
  /** The cloud's bundle-signing key; its thumbprint must equal the token's pin. */
  signing_key: Ed25519PublicJwkSchema.loose().optional(),
  /** A compact JWS (`typ: mp-relay`) over RelayPayload, signed with that key. */
  proof: z.string().min(1).optional(),
});
export type RelayAnswer = z.infer<typeof RelayAnswerSchema>;

export function relayControlName(domain: string): string {
  return `${RELAY_CONTROL_LABEL}.${domain}`;
}

/** A relay host's slug, or null for any other name (the control name too). */
export function relaySlugOf(host: string, domain: string): string | null {
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const slug = host.slice(0, -suffix.length);
  return GatewaySlugSchema.safeParse(slug).success ? slug : null;
}

/** Whether a host is the relay domain or under it. */
export function underRelayDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

// ── the PROXY line (PROXY protocol v1) ─────────────────────────────────────

/** The longest PROXY v1 line, its CRLF included. */
export const PROXY_LINE_MAX = 107;

export interface ProxyHeader {
  family: "TCP4" | "TCP6";
  source: string;
  destination: string;
  sourcePort: number;
  destinationPort: number;
}

const IPV4 =
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** Hex groups and colons, or an IPv4 tail; the relay writes what Node parsed. */
const IPV6 = /^[0-9A-Fa-f:]{2,39}$|^[0-9A-Fa-f:]{2,29}:\d{1,3}(\.\d{1,3}){3}$/;

const isPort = (n: number) => Number.isInteger(n) && n >= 0 && n <= 65535;

function addressOk(family: ProxyHeader["family"], address: string): boolean {
  return family === "TCP4"
    ? IPV4.test(address)
    : IPV6.test(address) && address.includes(":");
}

/** The PROXY line for a stream, CRLF included. */
export function proxyLine(h: ProxyHeader): string {
  if (
    !addressOk(h.family, h.source) ||
    !addressOk(h.family, h.destination) ||
    !isPort(h.sourcePort) ||
    !isPort(h.destinationPort)
  ) {
    throw new Error("not a PROXY header");
  }
  return `PROXY ${h.family} ${h.source} ${h.destination} ${h.sourcePort} ${h.destinationPort}\r\n`;
}

/**
 * Read a PROXY line at the start of `bytes`: "more" until its CRLF has
 * arrived, "invalid" if it isn't one, else the header (null for `UNKNOWN`)
 * and the line's length, so what follows can be read on.
 */
export function readProxyLine(
  bytes: Uint8Array,
): "more" | "invalid" | { header: ProxyHeader | null; length: number } {
  const prefix = "PROXY ";
  for (let i = 0; i < Math.min(bytes.length, prefix.length); i++) {
    if (bytes[i] !== prefix.charCodeAt(i)) return "invalid";
  }
  let end = -1;
  for (let i = 0; i + 1 < Math.min(bytes.length, PROXY_LINE_MAX); i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) {
      end = i;
      break;
    }
  }
  if (end < 0) return bytes.length >= PROXY_LINE_MAX ? "invalid" : "more";
  let line = "";
  for (let i = 0; i < end; i++) {
    const b = bytes[i] as number;
    if (b < 0x20 || b > 0x7e) return "invalid";
    line += String.fromCharCode(b);
  }
  const length = end + 2;
  const parts = line.split(" ");
  if (parts[1] === "UNKNOWN") return { header: null, length };
  if (parts.length !== 6) return "invalid";
  const [, family, source, destination, sp, dp] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (family !== "TCP4" && family !== "TCP6") return "invalid";
  if (!/^\d{1,5}$/.test(sp) || !/^\d{1,5}$/.test(dp)) return "invalid";
  const header: ProxyHeader = {
    family,
    source,
    destination,
    sourcePort: Number(sp),
    destinationPort: Number(dp),
  };
  if (
    !addressOk(family, source) ||
    !addressOk(family, destination) ||
    !isPort(header.sourcePort) ||
    !isPort(header.destinationPort)
  ) {
    return "invalid";
  }
  return { header, length };
}
