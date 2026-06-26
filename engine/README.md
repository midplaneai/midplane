# Midplane engine

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/midplaneai/midplane/actions/workflows/engine-test.yml/badge.svg)](https://github.com/midplaneai/midplane/actions/workflows/engine-test.yml)
[![Docs](https://img.shields.io/badge/docs-midplane.ai%2Fdocs-2ea44f.svg)](https://midplane.ai/docs)

The MIT query-path engine at the heart of [Midplane](../README.md): it parses every
SQL statement with a real Postgres AST, enforces the table-access policy and
guardrails, and writes the audit row **before** the query runs. The control plane
spawns this same engine for every project — cloud and self-host alike — so
enforcement is identical everywhere. It also ships on its own as the
`midplane/midplane` Docker image.

> 📖 **Documentation lives at [midplane.ai/docs](https://midplane.ai/docs)** — agent
> setup (Cursor / Claude Code / Claude Desktop), the CLI, the policy YAML reference,
> multi-database config, the threat model, and the adversarial corpus.

## Run it standalone

```bash
curl -O https://raw.githubusercontent.com/midplaneai/midplane/main/engine/.env.example
mv .env.example .env   # set DATABASE_URL
docker run --env-file .env -p 8080:8080 -v midplane-audit:/data midplane/midplane:latest
```

The MCP endpoint comes up at `http://localhost:8080/mcp`; point your agent at it.
Setup details are at [midplane.ai/docs](https://midplane.ai/docs).

> **Never put credentials on the docker command line** — `-e DATABASE_URL=…` leaks
> the password to `ps aux` and your shell history. Use `--env-file`.

## Develop

```bash
bun install
bun test                    # policy + adversarial corpus
bun run smoketest           # end-to-end against a sidecar Postgres
```

The highest-leverage contribution is a new entry in the adversarial SQL corpus — a
bypass attempt and the policy fix that defeats it. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## In this directory

- [`CHANGELOG.md`](./CHANGELOG.md) — version-by-version engine history
- [`THREAT_MODEL.md`](./THREAT_MODEL.md) — what the engine defends, and what it doesn't
- [`TELEMETRY.md`](./TELEMETRY.md) — what's collected, how to disable (`MIDPLANE_TELEMETRY=0`)
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`SECURITY.md`](./SECURITY.md) · [`LICENSE`](./LICENSE)
- [`docs/`](./docs) — engine source docs, mirrored and expanded at [midplane.ai/docs](https://midplane.ai/docs)

## License

MIT — see [`LICENSE`](./LICENSE).
