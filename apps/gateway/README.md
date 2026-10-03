# midplane

The Midplane gateway: an MCP server that sits between AI agents and your
Postgres databases. Every statement an agent sends is parsed, checked against
a policy and recorded before it runs. Agents get table access you grant,
masked columns, writes held for a person's approval, and containment once
they read untrusted content. It runs next to your databases; nothing connects
in to it.

```sh
npx midplane --version
```

Node 24.16 or newer.

- **Local mode** (`midplane local`): the policy lives in a YAML file and
  tokens come from `midplane token`. Try it with the
  [quickstart](https://github.com/midplaneai/midplane/tree/main/examples/quickstart).
- **Linked mode** (`midplane gateway`): policy, identities, approvals and a
  query log come from Midplane Cloud, over a link the gateway opens.
  `midplane setup` makes one: it asks for each database's connection string,
  tests it, writes the gateway's folder, enrolls and starts it.
- **The audit log** stays on the gateway's disk, hash-chained:
  `midplane audit export` and `midplane audit verify`.

Documentation: <https://midplane.ai/docs>.
The image: `ghcr.io/midplaneai/midplane`. Both are signed: see
[verifying a release](https://midplane.ai/docs/releases).

MIT licensed.
