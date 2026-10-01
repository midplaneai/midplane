// The URLs a gateway answers on. Laptop agents may reach it directly while
// a hosted agent comes in through a tunnel or the customer's ingress, each
// at its own URL. Every URL is a token audience the gateway accepts and a
// host name it answers to, and its protected resource metadata names the
// URL a request came in on, so each client asks for a token for the URL it
// uses. Which URL a token names doesn't matter here, as long as it is one
// of this gateway's; policy keys on the client, never on the URL.
//
// Local mode takes the URLs from its config. A linked gateway reports the
// URLs its config names; the cloud registers those no other gateway holds,
// plus any an operator adds on the dashboard, and the signed bundle lists
// what is registered. Only registered URLs are audiences.

/** The path of the MCP endpoint; each URL's resource is `<base URL>/mcp`. */
export const MCP_PATH = "/mcp";

/**
 * The names a loopback listener always answers to. A tunnel next to the
 * gateway may reach it by one (OpenAI's tunnel-client sends its upstream's
 * own address as Host), and a rebinding page can't: its Host is its own.
 */
const LOOPBACK_NAMES = ["localhost", "127.0.0.1", "[::1]"];

/** The host (with port) and host name a Host header names, if well formed. */
function hostOf(header: string | undefined): {
  host: string;
  hostname: string;
} | null {
  if (!header) return null;
  try {
    const url = new URL(`http://${header}`);
    return { host: url.host, hostname: url.hostname };
  } catch {
    return null;
  }
}

export interface PublicUrlsOptions {
  /** `<base URL>/mcp` for each URL the config names, in order; at least one. */
  configured: readonly string[];
  /** More host names to answer to, for a proxy that rewrites Host. */
  allowedHosts?: readonly string[];
  /** The listener is on loopback. */
  loopback?: boolean;
}

interface Parsed {
  resource: string;
  host: string;
  hostname: string;
}

function parse(resources: readonly string[]): Parsed[] {
  return resources.map((resource) => {
    const url = new URL(resource);
    return { resource, host: url.host, hostname: url.hostname };
  });
}

export class PublicUrls {
  /** `<base URL>/mcp` for each URL the config names, in order. */
  readonly configured: readonly string[];
  private readonly extraHosts: readonly string[];
  private registered: readonly string[] | null = null;
  /** The audiences, parsed once rather than on every request. */
  private accepted: Parsed[];
  private names: string[];

  constructor(o: PublicUrlsOptions) {
    if (o.configured.length === 0) throw new Error("a gateway needs a URL");
    this.configured = [...o.configured];
    this.extraHosts = [
      ...(o.allowedHosts ?? []),
      ...(o.loopback ? LOOPBACK_NAMES : []),
    ].map((h) => h.toLowerCase());
    this.accepted = parse(this.configured);
    this.names = this.namesOf();
  }

  /** The token audiences this gateway accepts. */
  audiences(): readonly string[] {
    return this.registered ?? this.configured;
  }

  /** What the newest enforced bundle registers for this gateway. */
  register(resources: readonly string[]): void {
    const accepted = parse(resources);
    this.registered = [...resources];
    this.accepted = accepted;
    this.names = this.namesOf();
  }

  /** Configured URLs the cloud hasn't registered for this gateway. */
  unregistered(): string[] {
    const registered = new Set(this.audiences());
    return this.configured.filter((r) => !registered.has(r));
  }

  /** Host names the Host header may name: DNS rebinding protection. */
  hostnames(): string[] {
    return this.names;
  }

  private namesOf(): string[] {
    const names = new Set(this.extraHosts);
    for (const p of [...parse(this.configured), ...this.accepted]) {
      names.add(p.hostname);
    }
    return [...names];
  }

  /**
   * The resource a request for `host` came in on: an audience of this
   * gateway with that host, else with that host name. A proxy that
   * rewrites Host hides it, so the first configured URL that is an
   * audience stands in. Never a URL this gateway would refuse tokens for.
   */
  resourceFor(host: string | undefined): string {
    const accepted = new Set(this.audiences());
    const first =
      this.configured.find((r) => accepted.has(r)) ??
      (this.accepted[0]?.resource as string);
    const want = hostOf(host);
    if (!want) return first;
    return (
      this.accepted.find((p) => p.host === want.host)?.resource ??
      this.accepted.find((p) => p.hostname === want.hostname)?.resource ??
      first
    );
  }
}

/** `<base>/mcp` for a base URL, without a trailing slash. */
export function resourceOf(base: string): string {
  return `${base.replace(/\/+$/, "")}${MCP_PATH}`;
}

/** The base URL of a resource: `<base>/mcp` without `/mcp`. */
export function baseOf(resource: string): string {
  return resource.endsWith(MCP_PATH)
    ? resource.slice(0, -MCP_PATH.length)
    : resource;
}
