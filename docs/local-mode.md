# Local mode

`midplane local` runs the gateway with no Midplane Cloud: each database's
policy is in `midplane.yaml`, and tokens are signed with a key you make. Use it
offline, to try Midplane ([quickstart](../examples/quickstart/README.md)), or
when you don't want a hosted control plane.

What it doesn't have: approvals (a held write is refused, with a pointer to
linking the gateway), a dashboard, and taint shared between instances (each
gateway keeps taint in its audit file).

## Keys and tokens

```sh
midplane keygen --out .
```

writes `midplane-signing-key.json` (private: keep it secret, it mints tokens)
and `midplane-verify-key.json` (public: `auth.public_key_file` names it). It
won't overwrite either.

```sh
midplane token --config midplane.yaml --key midplane-signing-key.json \
  --sub alice@example.com [--database main] [--access read|write] [--ttl 3600]
```

prints a token for one person (`--sub`), for one database or all of them,
`read` by default, valid for an hour by default. Each token is its own grant:
taint recorded for it doesn't follow its person to another token. A token
whose id is in `auth.revoked_token_ids` is refused.

## Serving

```sh
midplane local --config midplane.yaml            # MCP over HTTP at <url>/mcp
midplane local --config midplane.yaml --stdio    # MCP over stdin and stdout
```

Over HTTP, agents send the token as `Authorization: Bearer <token>`:

```sh
claude mcp add --transport http midplane http://127.0.0.1:7433/mcp \
  --header "Authorization: Bearer $(cat token.txt)"
```

Over stdio, the MCP client starts the gateway itself and passes the token in
`MIDPLANE_TOKEN`; it is verified at start and again on every call, so an
expired token stops working without a restart. Logs go to stderr, since
stdout carries MCP. Each session starts a gateway of its own; with one
config they share its audit file, as one chain, and the taint it keeps.

Stdio keeps an agent out only if it has no shell or file access: the
gateway's secrets (the DSN, the salt, the token) sit in the agent's MCP
config, and the gateway runs as the agent's own user. Beyond a demo, serve
over HTTP, with the gateway running as another user or on another host.

## What an agent can call

Four tools: `query` (one statement, with an optional `intent`, the agent's
reason), `list_tables`, `describe_table`, and `check_approval` (which, in
local mode, says approvals need a linked gateway).

*Tested by* `apps/gateway/test/cli.e2e.test.ts` (keygen, token, stdio) and
`apps/gateway/test/gateway.e2e.test.ts` (local mode end to end).
