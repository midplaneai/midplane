# Contributing to Midplane

Thanks for your interest. This repository is the Midplane **control plane** —
the dashboard, connection/policy management, audit views, and the hosted MCP
proxy. The query-path engine (SQL parsing, policy enforcement, guardrails)
lives in the separate, MIT-licensed [`midplaneai/midplane`](https://github.com/midplaneai/midplane)
repo; engine changes go there.

## Open-core boundary

The control plane is **open core**:

- Everything outside `apps/web/src/ee/` is MIT (the Community Edition) — the full
  single-tenant product: dashboard, policy editor, audit log, dry-run, local
  auth, every guardrail.
- `apps/web/src/ee/` is the commercial **Enterprise Edition** (see
  `apps/web/src/ee/LICENSE`): the governance band — SSO/SAML today, more later.

One rule, CI-enforced (ESLint `no-restricted-imports`): **MIT core must never
import from `ee/`.** `ee/` may import core, never the reverse, so deleting
`ee/` always leaves a working MIT build. If you're adding a feature, decide
which side of the line it's on (the rule of thumb: does it make a *single*
developer/agent safer → core; does it exist because an org has compliance/
identity/governance requirements → `ee/`). When in doubt, open an issue first.

## Development

```bash
bun install
cp .env.example .env.local   # fill in Better Auth, Postgres, KMS dev key
bun migrate:eu               # apply migrations to your dev database
bun dev                      # localhost:3000
```

Before opening a PR, from the repo root:

```bash
./node_modules/.bin/vitest run                 # unit suite
(cd apps/web && bun run typecheck && bun run lint)
```

- Match the surrounding code: the comment density and naming here are
  deliberate. New shared UI goes through the primitives in
  `apps/web/src/components/ui/` (see `DESIGN.md` before any visual change).
- Migrations are hand-written and registered in
  `packages/db/migrations/meta/_journal.json` — see the existing files for the
  pattern, and mirror new auth tables in `packages/db/src/auth-schema.ts`.
- Keep PRs focused; explain the "why" in the description.

## Support scope

Community support is best-effort via GitHub issues. Self-hosting is a single
supported artifact (`MIDPLANE_SELF_HOST=1`); we can't debug arbitrary custom
deployments. The managed cloud is the fully supported path.

## Reporting security issues

Do **not** open a public issue for a vulnerability — see [`SECURITY.md`](./SECURITY.md).
