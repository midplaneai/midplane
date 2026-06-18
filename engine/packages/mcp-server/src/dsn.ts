// Credential-safe helpers for DSNs and server endpoints, shared by the CLI
// subcommands (policy / doctor / init / query). ONE copy on purpose: this is
// the code that keeps secrets out of terminal output and generated files —
// duplicated copies drift, and drift here is a credential leak.

import type { Client } from "pg";

// Bounded Postgres connect timeout for CLI-side checks (doctor's ping, the
// wizard's introspection): a firewalled host should fail in seconds, not
// minutes. Shared so the two paths can't disagree about how long "trying to
// reach your database" takes.
export const PG_CONNECT_TIMEOUT_MS = 4000;

// Credential-free display form of a DSN: host:port/db. Never the userinfo.
export function displayHost(dsn: string): string {
  try {
    const u = new URL(dsn);
    return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable dsn>";
  }
}

// Remove every occurrence of a secret (DSN, token) from a message before it
// reaches a terminal or log — driver errors love echoing the connection
// string back.
export function scrub(msg: string, secret: string): string {
  return secret ? msg.split(secret).join("<dsn>") : msg;
}

// `host:port` → `http://host:port`; anything already carrying a scheme passes
// through. Callers decide what to do with the path (origin-only for admin
// endpoints, default /mcp for the MCP client).
export function ensureHttpScheme(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
}

// True for targets where sending a bearer token over plain http is fine
// (the token never leaves the machine).
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

// pg's connection-string parser emits a one-time process warning whenever a
// DSN sets sslmode=require|prefer|verify-ca: pg currently treats all three as
// verify-full, and a future major (pg v9) will weaken them. On a security
// CLI's very first command that multi-line "SECURITY WARNING" + stack trace
// reads like a failure — but our connections already get the strict
// verify-full behavior, so it's pure terminal noise. This is an OUTPUT concern
// only: we deliberately filter the message rather than rewrite the DSN's TLS
// parameters, so what we actually connect with is never changed by a cosmetic
// fix. Install-once; drop exactly that one message and forward every other
// process warning the way the runtime would have.
let sslWarningFilterInstalled = false;
function silenceSslModeAliasWarning(): void {
  if (sslWarningFilterInstalled) return;
  sslWarningFilterInstalled = true;
  const prior = process.listeners("warning") as Array<(w: Error) => void>;
  process.removeAllListeners("warning");
  process.on("warning", (w: Error) => {
    if (typeof w?.message === "string" && w.message.includes("aliases for 'verify-full'")) {
      return;
    }
    if (prior.length > 0) {
      // Node keeps its default printer as a normal listener — re-dispatch.
      for (const l of prior) l(w);
    } else {
      // Bun prints warnings internally and stops once any 'warning' listener
      // exists; re-emit in the runtime's default one-line format.
      process.stderr.write(`${w.name || "Warning"}: ${w.message}\n`);
    }
  });
}

// The ONE place the CLI builds a Postgres client for its read-only DB checks
// (doctor's ping, policy/init introspection). Centralizes three things that
// otherwise drift across call sites: the shared connect timeout, the lazy `pg`
// import (so the server/audit paths never pay for the driver), and the sslmode
// warning filter above. Returns an unconnected client — each caller owns its
// own connect/query/error handling and `client.end()`.
export async function newCliPgClient(url: string): Promise<Client> {
  silenceSslModeAliasWarning();
  const pg = (await import("pg")).default;
  return new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS,
  });
}
