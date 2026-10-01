# Midplane

A gateway between AI agents and your Postgres databases. Agents connect to it
over MCP. Every statement they send is parsed with Postgres' own parser,
decided against your policy, recorded, and only then run, with masks written
into the query itself.

- **Table access**, denied by default, per table.
- **Masking** at the source: hashes, partial values, generalized dates, NULLs,
  applied before any filter, join or aggregate sees the raw value.
- **Guardrails**: one statement at a time, writes need a `WHERE`, no writes
  hidden in a `WITH`, reads in read-only transactions with timeouts.
- **Approvals**: writes held for a person, bound to the exact statement and
  checked against the row count the approver saw.
- **Containment**: once an agent reads a column labeled untrusted (support
  tickets, emails), its writes are held and secret tables are closed to it.
- **An audit log** on the gateway's own disk, hash-chained, exported and
  verified with one command.

The gateway runs next to your databases and opens every connection itself.
Linked to [Midplane Cloud](https://midplane.ai), it gets policy authoring,
identities for agents, approvals and a query log, and the cloud still never
holds a database credential or sees a row.

## Try it

```sh
cd examples/quickstart
docker compose up -d --wait
```

then follow the [quickstart](examples/quickstart/README.md): a sample shop
database, the gateway in local mode with `npx midplane`, and Claude Code.

## Documentation

[docs/](docs/README.md): install, configuration, local and linked mode,
secrets, masking, approvals and taint, audit, operations, and verifying a
release.

## This repository

| Path | What |
| --- | --- |
| `apps/gateway` | The gateway: the `midplane` npm package and the container image |
| `packages/core` | The policy engine: parse, resolve, decide, rewrite. Pure functions, no I/O |
| `packages/protocol` | The schemas the gateway and Midplane Cloud exchange |
| `packages/corpus` | The test corpus, including every masking bypass we know of |
| `examples/quickstart` | The local quickstart |

```sh
corepack enable
pnpm install
pnpm run ci    # typecheck, lint, boundaries, tests
```

The end-to-end tests need a Postgres where they can create databases and
roles: `MIDPLANE_TEST_PG=postgres://postgres@127.0.0.1:5432/postgres pnpm run ci`.

This repository is a one-way mirror of the gateway's source; changes land in
Midplane's own repository first.

## Security

Found a way around a mask, a policy or the audit log? See
[SECURITY.md](SECURITY.md).

## License

MIT, see [LICENSE](LICENSE).
