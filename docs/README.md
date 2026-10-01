# Midplane documentation

Midplane puts a gateway between AI agents and your Postgres databases. Agents
connect to the gateway over MCP; it parses every statement, decides it against
your policy, records it, and only then runs it, with masks applied inside the
query. It runs next to your databases and opens every connection itself.

Start with the [quickstart](../examples/quickstart/README.md): a sample
database, the gateway in local mode and Claude Code, on your machine.

## Running a gateway

- [Install](install.md): `npx`, npm, or the container image.
- [Configuration](configuration.md): every key in `midplane.yaml`, and the
  policy.
- [Local mode](local-mode.md): the policy in a file, tokens from
  `midplane token`, no cloud.
- [Linked mode](linked-mode.md): enrollment, identities, bundles from
  Midplane Cloud, replicas.
- [Secrets](secrets.md): DSNs, the mask salt, the identity.
- [Hosted agents](hosted-agents.md): reaching a gateway from claude.ai,
  ChatGPT and other vendors' agents.
- [Operations](operations.md): health, logs, upgrades and the order to deploy
  in.

## What it enforces

- [Masking](masking.md): the transforms, unreviewed columns, known limits and
  the public bypass corpus.
- [Approvals and taint](approvals-and-taint.md): held writes and containment,
  from the operator's side.
- [Audit](audit.md): the local log, what goes to Midplane Cloud, export and
  verification.

## Releases

- [Verifying a release](releases.md): npm provenance, the image's signature
  and SBOM.

The gateway and everything in this repository is MIT licensed. Midplane
Cloud, the dashboard that authors policy and runs approvals, is a hosted
service.
