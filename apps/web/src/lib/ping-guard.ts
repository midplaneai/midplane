// SSRF guard for every server-side Postgres reachability probe. All
// three ping surfaces route through pingDsnGuarded — the pre-create
// raw-DSN test, the add-database test, and the saved-db test:
//
//   dsn ──► parse host ──► resolve A/AAAA (all records)
//                │                │
//          IP literal       ANY blocked? ──► generic error, NO dial
//                │                │
//                └──► vet ──► dial the VETTED IP (not the hostname,
//                             so DNS rebinding can't swap the target
//                             between check and connect), with TLS
//                             servername pinned to the original host
//                             (Neon/Supabase poolers route by SNI and
//                             verify-full checks the cert against it).
//
// Blocked space: loopback, RFC1918, CGNAT, link-local (incl. the
// 169.254.169.254 metadata service), IPv6 ULA (covers Fly 6PN fdaa::),
// IPv6 link-local, unspecified. Unknown shapes fail CLOSED.
//
// Error copy: blocked hosts return the same generic message as an
// unreachable public host, so the endpoint can't be used as an
// internal-network reachability oracle. Driver errors from vetted
// public hosts pass through verbatim (the user is debugging their own
// DSN — "password authentication failed" is useful, not a leak).
//
// Toggle: PING_GUARD=on|off (explicit), default on in production and
// off elsewhere — local dev legitimately pings postgres://localhost.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import { pingDsn, type PingDsnResult } from "@/lib/ping-dsn";

export const GENERIC_PING_ERROR =
  "Could not connect. Check the host, port, and that the database accepts connections from the internet.";

export function pingGuardEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.PING_GUARD === "on") return true;
  if (env.PING_GUARD === "off") return false;
  return env.NODE_ENV === "production";
}

/** True when the address must never be dialed from the cloud. Fail
 *  closed: anything that doesn't parse as a routable public IP is
 *  blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true; // not an IP at all — fail closed
}

function isBlockedV4(ip: string): boolean {
  const octets = ip.split(".").map(Number);
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) — vet the embedded v4.
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    if (isIP(tail) === 4) return isBlockedV4(tail);
    return true; // hex-form mapped or anything odd — fail closed
  }
  // Any other dotted form we didn't parse — fail closed.
  if (lower.includes(".")) return true;
  if (lower === "::" || lower === "::1") return true; // unspecified / loopback
  const head = lower.split(":")[0] ?? "";
  // fc00::/7 — unique local (Fly 6PN lives at fdaa::).
  if (head.length === 4 && (head.startsWith("fc") || head.startsWith("fd"))) {
    return true;
  }
  // fe80::/10 — link-local.
  if (
    head.length === 4 &&
    (head.startsWith("fe8") || head.startsWith("fe9") ||
      head.startsWith("fea") || head.startsWith("feb"))
  ) {
    return true;
  }
  return false;
}

export type VetResult =
  | { ok: true; hostname: string; address: string | null }
  | { ok: false };

export interface PingGuardDeps {
  lookup?: typeof dnsLookup;
  ping?: typeof pingDsn;
  env?: Record<string, string | undefined>;
}

/** Parse the DSN's host and vet it. For hostnames, resolves ALL A/AAAA
 *  records and rejects if ANY is blocked — a resolver answering
 *  [public, private] is exactly the rebinding/split-horizon shape this
 *  exists to stop. Returns the pinned address to dial (null when the
 *  DSN host is already an IP literal — dial as-is). */
export async function vetDsnHost(
  dsn: string,
  deps: PingGuardDeps = {},
): Promise<VetResult> {
  const lookup = deps.lookup ?? dnsLookup;

  let hostname: string;
  try {
    hostname = new URL(dsn).hostname;
  } catch {
    return { ok: false };
  }
  // URL keeps brackets on IPv6 literals.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }
  if (!hostname) return { ok: false };

  if (isIP(hostname) !== 0) {
    return isBlockedAddress(hostname)
      ? { ok: false }
      : { ok: true, hostname, address: null };
  }

  let entries: Array<{ address: string }>;
  try {
    entries = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    // NXDOMAIN / resolver failure — nothing to dial. Same generic
    // outcome as blocked, so name-vs-address probing learns nothing.
    return { ok: false };
  }
  if (entries.length === 0) return { ok: false };
  if (entries.some((e) => isBlockedAddress(e.address))) return { ok: false };
  return { ok: true, hostname, address: entries[0]!.address };
}

/** TLS intent from the DSN itself. We only force the ssl option (with
 *  the pinned servername) when the DSN REQUIRES TLS — `prefer`/`allow`
 *  are opportunistic, and injecting an ssl object would turn them into
 *  mandatory-TLS probes that fail plain-TCP servers the DSN itself
 *  accepts (codex review P2). For opportunistic modes the driver
 *  negotiates as usual against the pinned IP. */
function wantsTls(dsn: string): boolean {
  try {
    const url = new URL(dsn);
    const sslmode = url.searchParams.get("sslmode");
    if (sslmode) {
      return (
        sslmode === "require" ||
        sslmode === "verify-ca" ||
        sslmode === "verify-full"
      );
    }
    const ssl = url.searchParams.get("ssl");
    return ssl === "true" || ssl === "1";
  } catch {
    return false;
  }
}

export async function pingDsnGuarded(
  dsn: string,
  deps: PingGuardDeps = {},
): Promise<PingDsnResult> {
  const ping = deps.ping ?? pingDsn;
  if (!pingGuardEnabled(deps.env)) return ping(dsn);

  const vetted = await vetDsnHost(dsn, deps);
  if (!vetted.ok) return { ok: false, error: GENERIC_PING_ERROR };

  // IP-literal host: already vetted, dial as-is.
  if (vetted.address === null) return ping(dsn);

  return ping(dsn, {
    hostOverride: vetted.address,
    tlsServername: wantsTls(dsn) ? vetted.hostname : undefined,
  });
}
