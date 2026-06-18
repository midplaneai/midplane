# Contributing to Midplane

Thanks for your interest. This repository is the Midplane monorepo: the
**control plane** (dashboard, connection/policy management, audit views, the
hosted MCP proxy) at the root, and the query-path **engine** (SQL parsing,
policy enforcement, guardrails) under [`engine/`](./engine) — an MIT subtree
with its own [`engine/CONTRIBUTING.md`](./engine/CONTRIBUTING.md) (the highest-
value contributions there are SQL-bypass attempts and the policy fixes that
defeat them) and [`engine/THREAT_MODEL.md`](./engine/THREAT_MODEL.md). One
codebase, two deployables: the engine ships as its own minimal Docker image,
the control plane as one web app.

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

External pull requests to `apps/web/src/ee/` aren't accepted — that directory is
commercial and maintainer-owned (enforced via `CODEOWNERS`). If you want to
propose an `ee/` change, open an issue and we'll take it from there.

## Development

```bash
bun install
cp .env.example .env.local   # fill in Better Auth, Postgres, KMS dev key
bun migrate:eu               # apply migrations to your dev database
bun dev                      # localhost:3000
```

Before opening a PR, from the repo root:

```bash
./node_modules/.bin/vitest run                 # control-plane unit suite
bun run test:engine                            # engine bun:test suite (cd engine && bun test)
(cd apps/web && bun run typecheck && bun run lint)
```

- Match the surrounding code: the comment density and naming here are
  deliberate. New shared UI goes through the primitives in
  `apps/web/src/components/ui/` (see `DESIGN.md` before any visual change).
- Migrations are hand-written and registered in
  `packages/db/migrations/meta/_journal.json` — see the existing files for the
  pattern, and mirror new auth tables in `packages/db/src/auth-schema.ts`.
- Keep PRs focused; explain the "why" in the description.

## Commit & PR conventions

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): description` (e.g. `feat(audit): connection-scoped audit log`).
Common types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`, `security`.

## Sign your commits (DCO)

Sign every commit with `git commit -s`. By signing you certify the
[Developer Certificate of Origin](https://developercertificate.org/) — you wrote
the change, or have the right to submit it under the project's license. We don't
require a separate CLA. (The engine subtree has required this all along; it now
applies repo-wide.)

## Support scope

Community support is best-effort via GitHub issues. Self-hosting is a single
supported artifact (`MIDPLANE_SELF_HOST=1`); we can't debug arbitrary custom
deployments. The managed cloud is the fully supported path.

## Reporting security issues

Do **not** open a public issue for a vulnerability — see [`SECURITY.md`](./SECURITY.md).
