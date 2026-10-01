// The HTTP face: MCP over Streamable HTTP at /mcp, behind bearer auth;
// protected resource metadata (RFC 9728) so clients find how to authorize;
// liveness and readiness probes. Nothing else: the cloud never calls a
// gateway, which opens every link connection itself.
//
// A gateway may answer on several URLs (urls.ts). Every request must name
// one of its hosts, and the metadata names the URL a request came in on.

import { localhostOriginValidation } from "@modelcontextprotocol/hono";
import {
  createMcpHandler,
  requireBearerAuth,
  validateHostHeader,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import { type TokenVerifier, verifiedCallerOf } from "./auth.ts";
import { isLoopback } from "./config.ts";
import type { Gateway } from "./gateway.ts";
import { createServerFactory } from "./tools.ts";
import { baseOf, MCP_PATH, type PublicUrls } from "./urls.ts";

export { MCP_PATH };

export interface HttpOptions {
  gateway: Gateway;
  verifier: TokenVerifier;
  issuer: string;
  /** The URLs this gateway answers on; a bundle may change them. */
  urls: PublicUrls;
  listenHost: string;
  /** Called once per client and MCP protocol version seen, for the log. */
  onClient?: (client: {
    clientId: string;
    sub: string;
    protocol: string;
  }) => void;
}

export function buildApp(o: HttpOptions): Hono {
  const app = new Hono();
  // DNS rebinding protection, against this gateway's host names as they
  // are now: a newly registered URL is answered without a restart.
  app.use("*", async (c, next) => {
    const host = validateHostHeader(c.req.header("host"), o.urls.hostnames());
    if (!host.ok) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: host.message },
          id: null,
        },
        403,
      );
    }
    await next();
  });
  // As the MCP SDK does for a server on loopback: browsers only from there.
  if (isLoopback(o.listenHost)) app.use("*", localhostOriginValidation());

  const metadataUrl = (host: string | undefined) =>
    `${baseOf(o.urls.resourceFor(host))}/.well-known/oauth-protected-resource${MCP_PATH}`;

  const handler = createMcpHandler(
    createServerFactory(o.gateway, (auth) => async () => {
      const caller = verifiedCallerOf(
        auth as Parameters<typeof verifiedCallerOf>[0],
      );
      if (!caller) throw new Error("unauthenticated request reached a tool");
      return caller;
    }),
  );

  const metadata = (host: string | undefined) => {
    // No scopes_supported: database access is picked per grant at consent
    // and travels in the token's `databases` claim, so this resource has no
    // scopes of its own and clients take the authorization server's defaults.
    const doc: Record<string, unknown> = {
      resource: o.urls.resourceFor(host),
      bearer_methods_supported: ["header"],
    };
    if (URL.canParse(o.issuer)) doc.authorization_servers = [o.issuer];
    return doc;
  };
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(metadata(c.req.header("host"))),
  );
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, (c) =>
    c.json(metadata(c.req.header("host"))),
  );

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/readyz", async (c) =>
    (await o.gateway.ready()) ? c.text("ready") : c.text("not ready", 503),
  );

  const seenClients = new Set<string>();
  app.all(MCP_PATH, async (c) => {
    // A linked gateway without keys yet can verify no one: say so instead
    // of sending clients into an authorization loop. Why is for its logs
    // and the dashboard, not for anyone who asks.
    if (!o.verifier.hasKeys) {
      return c.json(
        {
          error: "temporarily_unavailable",
          error_description:
            "this gateway isn't enforcing a policy from Midplane Cloud yet",
        },
        503,
        { "retry-after": "5" },
      );
    }
    const auth = await requireBearerAuth({
      verifier: o.verifier.asOAuthVerifier(),
      resourceMetadataUrl: metadataUrl(c.req.header("host")),
    })(c.req.raw);
    if (auth instanceof Response) return auth;
    // Client-supplied, so only a well-formed version is logged.
    const protocol = c.req.header("mcp-protocol-version");
    const caller = verifiedCallerOf(auth);
    if (
      protocol &&
      /^\d{4}-\d{2}-\d{2}$/.test(protocol) &&
      caller &&
      o.onClient
    ) {
      const key = `${caller.claims.client_id} ${caller.claims.sub} ${protocol}`;
      if (!seenClients.has(key) && seenClients.size < 10_000) {
        seenClients.add(key);
        o.onClient({
          clientId: caller.claims.client_id,
          sub: caller.claims.sub,
          protocol,
        });
      }
    }
    return handler.fetch(c.req.raw, { authInfo: auth });
  });

  return app;
}
