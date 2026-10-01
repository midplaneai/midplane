# Reaching a gateway from hosted agents

Agents on laptops or in your own cluster (Claude Code, Cursor, VS Code, your own
agents) connect to the gateway directly. Hosted agents run on their vendor's
servers: claude.ai connectors, ChatGPT and background agents. They can reach an
MCP server only at a public HTTPS URL, and your gateway sits in your network.

Midplane doesn't relay this traffic: query results never reach Midplane Cloud.
You make the gateway reachable with what you already run, or with the tunnel
your agent vendor offers, and you register each URL the gateway answers on.

## One gateway, several URLs

A gateway can answer on several URLs at once: its direct URL, plus any tunnel
or ingress URL in front of it. List them all in its config:

```yaml
# midplane.yaml
listen: { host: 127.0.0.1, port: 7433 }
public_urls:
  - https://midplane.abc123.tunnel.anthropic.com   # a tunnel for claude.ai
  - https://db-gateway.internal.example.com        # laptops, through your ingress
```

- **Tokens.** Each URL is a token audience. The gateway accepts a token that
  names any of its URLs, and refuses a token that names none of them. Policy
  is the same on every URL: it keys on the agent, not on the URL it came in
  on.
- **Metadata.** The gateway's protected resource metadata names the URL a
  client came in on, so each client asks for a token for the URL it uses.
- **Host names.** The gateway answers only requests for its own host names,
  which protects against DNS rebinding. A request for any other name gets a
  403. A gateway listening on loopback also answers to `localhost`,
  `127.0.0.1` and `[::1]`. If a proxy in front of it rewrites the Host header
  to another name, add that name to `listen.allowed_hosts`.
- **Registration.** Only registered URLs are audiences, and only a project
  manager registers one. The URLs in the config when a gateway enrolls are
  registered then, under the enrollment token. A linked gateway reports its
  `public_urls` on every sync; one you add to the config later waits on the
  project's Gateways page until a project manager registers it there, since
  whoever can edit the config or holds the gateway's identity shouldn't be
  able to add audiences on their own. You can also register a URL that isn't
  in the config. A URL you remove from the config is dropped within ten
  minutes, or at once on the Gateways page. A URL another live gateway holds
  can't be registered: the Gateways page and the gateway's log say so (`public
  URL not registered`).
- **Revoking.** Revoking a gateway frees its URLs for another gateway. Stop
  the revoked gateway's process too: it keeps its last bundle, and so keeps
  accepting tokens that name those URLs.
- **TLS.** The gateway requires TLS whenever it listens off loopback. Run a
  tunnel next to it over loopback (in one Kubernetes pod, or one network
  namespace in Compose), or give the gateway a certificate (`tls`).

A proxy that rewrites Host hides which URL a client used. The gateway's
metadata then names its first URL, so list the tunnel's URL first in
`public_urls` when it is the only way in that rewrites Host.

## Which option fits

| Where the agent runs | What you do | Who can read traffic |
| --- | --- | --- |
| Laptops or your own cluster (Claude Code, Cursor, VS Code) | Nothing extra: connect directly | Only you |
| claude.ai or ChatGPT, with the vendor's tunnel | Run the vendor's tunnel next to the gateway, and register the tunnel URL | The agent vendor, which is the client anyway |
| Hosted agents without a vendor tunnel | Give the gateway a public URL: your load balancer, allowlisted to the vendor's IP ranges, or a public deployment in your own cloud account | Only you |

> **Tunnels that decrypt can read your data.** Cloudflare Tunnel terminates
> TLS at Cloudflare's edge, and ngrok does too unless you turn on its
> end-to-end TLS. Either provider can then read queries, results and tokens.
> Use them only if you accept that.

In every option, the hosted agent's vendor sees query results, because it is
the client. Midplane never does.

## Claude: Anthropic MCP tunnels

Anthropic's MCP tunnels are in research preview. For claude.ai they need the
Enterprise plan and a request to Anthropic; tunnels for the Claude Console and
API are separate. Set one up with [Anthropic's guide][anthropic-setup] first.

- **Parts.** You run `cloudflared` and Anthropic's `mcp-proxy`. `cloudflared`
  holds an outbound connection to Cloudflare. Traffic inside it is encrypted
  again from Anthropic to `mcp-proxy` with a certificate from your own CA, so
  Cloudflare carries ciphertext.
- **URL.** A route named `midplane` gets
  `https://midplane.<tunnel domain>`. Register that URL; the connector URL in
  claude.ai is `https://midplane.<tunnel domain>/mcp`.
- **Loopback.** By default `mcp-proxy` connects only to RFC 1918 addresses.
  To reach the gateway over loopback, set `upstream.allowed_ips` to
  `127.0.0.1/32`. That replaces the default list, so the proxy reaches
  nothing off this network namespace, though anything else listening on its
  loopback (such as `cloudflared`'s metrics) is in reach too. Routes decide
  which host names go where.
- **Host header.** Anthropic doesn't document which Host `mcp-proxy` sends
  upstream. If it sends `127.0.0.1:7433`, a loopback gateway answers to it,
  and its metadata names its first URL: list the tunnel URL first.
- **Names.** Anthropic's proxy runs as `mcp-proxy`, reads
  `/etc/mcp-gateway/config.yaml`, and its Helm values call it `gateway`. Name
  Midplane's service `midplane-gateway`, never `mcp-proxy` or `mcp-gateway`.

### Docker Compose

The gateway shares `mcp-proxy`'s network namespace, as `cloudflared` does, so
the proxy reaches it on `127.0.0.1`. Take the image digests and the
certificate setup from [Anthropic's Compose guide][anthropic-compose].

```yaml
# compose.yaml
services:
  mcp-proxy:
    image: us-docker.pkg.dev/anthropic-public-registry/images/mcp-proxy@sha256:<digest>
    volumes:
      - ./config/mcp-proxy.yaml:/etc/mcp-gateway/config.yaml:ro
      - ./data:/data:ro
  cloudflared:
    image: cloudflare/cloudflared@sha256:<digest>
    command: tunnel --no-autoupdate run --url http://localhost:8080
    environment: [TUNNEL_TOKEN]
    network_mode: "service:mcp-proxy"
  midplane-gateway:
    image: ${MIDPLANE_IMAGE}   # the gateway image
    command: gateway --config /etc/midplane/midplane.yaml
    environment: [MIDPLANE_ENROLLMENT_TOKEN, MAIN_DSN, MIDPLANE_MASK_SALT]
    volumes:
      - ./midplane:/etc/midplane
    network_mode: "service:mcp-proxy"
```

```yaml
# config/mcp-proxy.yaml
listen_addr: ":8080"
tunnel_domain: ${TUNNEL_DOMAIN}
tls:
  cert_file: /data/tls.crt
  key_file: /data/tls.key
routes:
  midplane: http://127.0.0.1:7433
upstream:
  allowed_ips: ["127.0.0.1/32"]
```

```yaml
# midplane/midplane.yaml
listen: { host: 127.0.0.1, port: 7433 }
public_urls:
  - https://midplane.abc123.tunnel.anthropic.com
audit: { file: /etc/midplane/audit.db }
mask_salt: { env: MIDPLANE_MASK_SALT }
link:
  cloud_url: https://cloud.midplane.example
  identity: { file: /etc/midplane/identity.json }
  enrollment_token: { env: MIDPLANE_ENROLLMENT_TOKEN }
databases:
  main: { dsn: { env: MAIN_DSN } }
```

### Kubernetes

Anthropic's Helm chart (`mcp-tunnel`) runs `cloudflared` and `mcp-proxy` in a
pod of its own and takes no extra containers, so the gateway can't join it on
loopback. The hop from the proxy to the gateway then crosses the cluster
network, where the gateway requires TLS:

1. Give the gateway a certificate from your internal CA (`tls` in its
   config), listen on `0.0.0.0`, and put a Service named `midplane-gateway` in
   front of it. Add a NetworkPolicy that lets only the tunnel's pods reach
   port 7433. The proxy may send the Service's name as Host, so add it to
   `listen.allowed_hosts` (not to `public_urls`: it isn't a URL agents use).
2. Route the chart to that Service over `https`, and have the proxy trust your
   CA with `upstream.tls.ca_file` (see [Anthropic's Helm guide][anthropic-helm]
   for mounting it):

```yaml
# values for Anthropic's mcp-tunnel chart
gateway:
  config:
    routes:
      midplane: https://midplane-gateway.midplane.svc.cluster.local:7433
    upstream:
      tls:
        ca_file: /etc/midplane-ca/ca.crt
```

```yaml
# midplane.yaml, the parts that differ from the Compose example
listen:
  host: 0.0.0.0
  port: 7433
  allowed_hosts: [midplane-gateway.midplane.svc.cluster.local]
tls: { cert_file: /etc/midplane-tls/tls.crt, key_file: /etc/midplane-tls/tls.key }
public_urls:
  - https://midplane.abc123.tunnel.anthropic.com
```

Pod addresses are usually RFC 1918, which the proxy allows by default.

## ChatGPT and Codex: OpenAI Secure MCP Tunnel

OpenAI's Secure MCP Tunnel serves ChatGPT developer mode, Codex and the
Responses API, not publicly listed apps. You run OpenAI's open-source
[`tunnel-client`][openai-tunnel-client], which long-polls OpenAI over outbound
HTTPS and forwards each request to the gateway. TLS ends at OpenAI, which is
the client anyway.

- **Setup.** Create a tunnel as [OpenAI's guide][openai-tunnels] describes,
  then point `tunnel-client` at the gateway:
  `MCP_SERVER_URL=http://127.0.0.1:7433/mcp`. Your authorization server is
  Midplane Cloud, on another origin than the gateway, so add its origin to
  `MCP_OAUTH_TRUSTED_ORIGINS`. Its docs ask for
  `--harpoon.allow-plaintext-http` to discover OAuth metadata over plain
  loopback HTTP.
- **Host header.** `tunnel-client` sends the upstream's own address as Host,
  `127.0.0.1:7433` here. A gateway listening on loopback answers to it.
- **Resource URL: not verified yet.** `tunnel-client`'s docs say it rewrites
  the `resource` in the gateway's metadata to an OpenAI URL for your tunnel,
  so ChatGPT would ask Midplane Cloud for a token for that URL, which must be
  one of the gateway's URLs. OpenAI doesn't document its form, and Midplane
  registers only URLs whose path ends in `/mcp`. Until a real run settles
  this, ChatGPT through OpenAI's tunnel may not finish signing in.

### Docker Compose

`tunnel-client` shares the gateway's network namespace:

```yaml
# compose.yaml
services:
  midplane-gateway:
    image: ${MIDPLANE_IMAGE}   # the gateway image
    command: gateway --config /etc/midplane/midplane.yaml
    environment: [MIDPLANE_ENROLLMENT_TOKEN, MAIN_DSN, MIDPLANE_MASK_SALT]
    volumes:
      - ./midplane:/etc/midplane
  tunnel-client:
    image: ghcr.io/openai/tunnel-client:<version>
    environment:
      CONTROL_PLANE_API_KEY: ${CONTROL_PLANE_API_KEY}
      CONTROL_PLANE_TUNNEL_ID: tunnel_0123456789abcdef0123456789abcdef
      MCP_SERVER_URL: http://127.0.0.1:7433/mcp
      MCP_OAUTH_TRUSTED_ORIGINS: https://cloud.midplane.example
    network_mode: "service:midplane-gateway"
```

### Kubernetes

The gateway and `tunnel-client` run in one pod and talk over loopback, the
pattern OpenAI documents. Midplane has no Helm chart yet; this is the pod to
deploy.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: midplane-gateway
spec:
  replicas: 1
  selector:
    matchLabels: { app: midplane-gateway }
  template:
    metadata:
      labels: { app: midplane-gateway }
    spec:
      containers:
        - name: midplane-gateway
          image: MIDPLANE_IMAGE   # the gateway image
          args: [gateway, --config, /etc/midplane/midplane.yaml]
          env:
            - name: MIDPLANE_IDENTITY   # what `midplane enroll` printed
              valueFrom: { secretKeyRef: { name: midplane, key: identity } }
            - name: MIDPLANE_MASK_SALT
              valueFrom: { secretKeyRef: { name: midplane, key: mask-salt } }
            - name: MAIN_DSN
              valueFrom: { secretKeyRef: { name: midplane, key: main-dsn } }
          volumeMounts:
            - { name: config, mountPath: /etc/midplane }
            - { name: state, mountPath: /var/lib/midplane }
        - name: tunnel-client
          image: ghcr.io/openai/tunnel-client:<version>
          env:
            - name: CONTROL_PLANE_TUNNEL_ID
              value: tunnel_0123456789abcdef0123456789abcdef
            - name: CONTROL_PLANE_API_KEY
              valueFrom: { secretKeyRef: { name: openai-tunnel, key: api-key } }
            - name: MCP_SERVER_URL
              value: http://127.0.0.1:7433/mcp
            - name: MCP_OAUTH_TRUSTED_ORIGINS
              value: https://cloud.midplane.example
      volumes:
        - name: config
          configMap: { name: midplane-gateway }
        - name: state   # use a persistent volume to keep the audit log
          emptyDir: {}
```

```yaml
# midplane.yaml, in the midplane-gateway ConfigMap
listen: { host: 127.0.0.1, port: 7433 }
public_urls:
  - https://…   # the URL OpenAI names for your tunnel; see "Resource URL"
audit: { file: /var/lib/midplane/audit.db }
mask_salt: { env: MIDPLANE_MASK_SALT }
link:
  cloud_url: https://cloud.midplane.example
  identity: { env: MIDPLANE_IDENTITY }
  bundle_cache: /var/lib/midplane/bundle.jws
databases:
  main: { dsn: { env: MAIN_DSN } }
```

The ConfigMap is read-only and a pod has no identity file, so enroll once
with `midplane enroll` and keep the identity it prints in the secret.

## Your own endpoint

When a hosted agent has no vendor tunnel, give the gateway a public URL:

- **Your load balancer or ingress**, in front of the gateway. Allow only the
  vendor's egress ranges: Anthropic publishes
  [its IP addresses][anthropic-ips], OpenAI its
  [ChatGPT connector ranges][openai-ips]. TLS ends at your load balancer, or
  passes through to the gateway's own certificate.
- **A public deployment in your own cloud account**, with `tls` and the
  gateway listening on `0.0.0.0`.

Add the URL to `public_urls`. If the load balancer rewrites Host, add that
name to `listen.allowed_hosts`.

[anthropic-setup]: https://claude.com/docs/connectors/mcp-tunnels/setup
[anthropic-compose]: https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/deploy-compose
[anthropic-helm]: https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/deploy-helm
[anthropic-ips]: https://platform.claude.com/docs/en/api/ip-addresses
[openai-tunnels]: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
[openai-tunnel-client]: https://github.com/openai/tunnel-client
[openai-ips]: https://developers.openai.com/api/docs/guides/ip-addresses
