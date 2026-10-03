# Contributing

This repository is a one-way mirror of the gateway's source; changes land in
Midplane's own repository first. Bugs and questions go to
[issues](https://github.com/midplaneai/midplane/issues). A way around a mask,
a policy or the audit log is a vulnerability: report it privately, as
[SECURITY.md](SECURITY.md) describes.

## Layout

| Path | What |
| --- | --- |
| `apps/gateway` | The gateway: the `midplane` npm package and the container image |
| `packages/core` | The policy engine: parse, resolve, decide, rewrite. Pure functions, no I/O |
| `packages/protocol` | The schemas the gateway and Midplane Cloud exchange |
| `packages/corpus` | The test corpus, including every masking bypass we know of |
| `examples/quickstart` | The local quickstart |
| `docs` | The documentation site at [midplane.ai/docs](https://midplane.ai/docs), built with Mintlify ([docs/README.md](docs/README.md)) |

## Build and test

```sh
corepack enable
pnpm install
pnpm run ci    # typecheck, lint, boundaries, tests
```

The end-to-end tests need a Postgres where they can create databases and
roles: `MIDPLANE_TEST_PG=postgres://postgres@127.0.0.1:5432/postgres pnpm run ci`.

The README's demo, `docs/images/quickstart-demo.gif`, is recorded with
[VHS](https://github.com/charmbracelet/vhs) from
`scripts/quickstart-demo.tape`; its header says how.
