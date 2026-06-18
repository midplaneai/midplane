# Agent operating notes — midplane-cloud

This is the canonical guidance file for AI coding agents working in this
repository, following the [AGENTS.md](https://agents.md) convention. Tool-specific
files (e.g. `CLAUDE.md`) point here so there is one source of truth. A nested
`AGENTS.md` in a subdirectory, if present, takes precedence for files in its
subtree.

## Monorepo layout (one codebase, two deployables)

- **Control plane** (repo root: `apps/web`, `packages/{db,kms,router}`,
  `infra/telemetry-proxy`) — the web app + hosted MCP proxy. Tests: **vitest**
  (`./node_modules/.bin/vitest run`). MIT except `apps/web/src/ee/` (commercial).
- **Engine** (`engine/`, grafted via `git subtree`) — the MIT query-path engine,
  shipped as the compiled `midplane/midplane` Docker image. Tests: **`bun test`**
  via `bun run test:engine` (NEVER a bare `bun test` from root — it would sweep in
  the control-plane vitest files). Engine governance lives under `engine/`
  (LICENSE, THREAT_MODEL.md, TELEMETRY.md, CONTRIBUTING.md, SECURITY.md).

One root `bun.lock` covers everything (`linker = "hoisted"`). The engine image is
a self-contained `bun build --compile` binary (`engine/docker/Dockerfile`, repo-root
context) — no `node_modules` in the runtime image. CI: `engine-test.yml` /
`engine-publish.yml` (tags `engine-v*`) are separate from the control-plane
`deploy-fly.yml`. The engine still ships as its own image, so the version pin
persists — see "OSS image version pin sites" below.

## Design System

Always read `DESIGN.md` (at repo root) before making any visual or UI decision.
All font choices, colors, spacing, border-radius scale, and aesthetic direction
are defined there. Do not deviate without explicit user approval.

The actual tokens are wired into `apps/web/src/app/globals.css` and exposed to
Tailwind via `apps/web/tailwind.config.ts`. Do not introduce parallel design
systems (e.g., page-scoped CSS files with their own color variables). The
`/audit` page used to do this with `audit.css` and was consolidated. Don't
recreate the split.

When writing a new page or component:
- Use the shared primitives in `apps/web/src/components/ui/` (`Button`, `Input`,
  `Label`, `Card`, `Badge`, `EmptyState`, `PageHeader`). Add a new primitive
  there before inlining the same Tailwind class string twice.
- Authenticated pages live under `app/(app)/` and inherit the `AppShell`
  (sidebar + topbar). Don't render your own page chrome.
- Use semantic color tokens (`allow`, `deny`, `warn`) for anything tied to
  query-lifecycle decisions. Don't reach for generic green/red/yellow.

## Client-component imports from `@midplane-cloud/db`

The root entrypoint (`@midplane-cloud/db`) re-exports `getDb`, which pulls
in the `postgres` driver — a Node-only package that needs `fs`/`os`. Any
file with `"use client"` at the top must import from the
`@midplane-cloud/db/policy` subpath instead, which is pure TS (types +
validators + serializers, no runtime deps).

Typecheck passes either way. The failure is a build-time Turbopack
explosion: `Module not found: Can't resolve 'fs'` traced back through the
client component. If you see that error after touching a client file's
imports, this is the cause.

Server components, server actions, route handlers, and library code may
import from the root entrypoint freely.

## Server actions: return state, don't throw, for user input

A server action reached by a direct `<form action={X}>` (no client
wrapper) must return a state object for user-recoverable validation
errors — not `throw`. A throw becomes the Next.js runtime-error
overlay because there is no client `try/catch` between the action
and the user. The new-connection form (`app/(app)/connections/new`)
shows the pattern: `useActionState`, action signature
`(prev, formData) => Promise<{ error? }>`, success still calls
`redirect()` (Next handles `NEXT_REDIRECT` outside the state channel).

Throws are still fine for tamper-only paths (e.g. a hidden `id` input
that's never user-edited) — those aren't reachable through normal UI.
The distinction is whether a non-adversarial user can trigger the
throw by interacting with the form.

If a server action sits behind a client component that already wraps
the call in `try/catch` + `useTransition` (see `add-database-form.tsx`,
`rotate-connection-form.tsx`), throwing is also fine — the client
catches and renders inline.

## OSS image version pin sites

The OSS engine image version (`midplane/midplane:X.Y.Z`) has a single source
of truth: **`OSS_ENGINE_IMAGE` in `packages/router/src/oss-image.ts`**. The TS
sites import it; the non-TS sites carry a literal and are policed by a CI drift
check. Bumping the engine:

1. Edit `OSS_ENGINE_IMAGE` in `packages/router/src/oss-image.ts`.
2. Run `bun scripts/check-image-pin.ts` — it fails and lists every config/doc
   site that still disagrees. Update those, re-run until green.

- TS (import the constant — do NOT hand-edit): `spawner-docker.ts`,
  `spawner-fly.ts`, and the current-pin references in
  `packages/router/test/spawner-{docker,fly}.test.ts`. (The fly suite's
  `0.8.0` literals are deliberately-stale comparison fixtures, not pin sites.)
- Literal sites the drift check enforces: `scripts/dev-image.sh`,
  `scripts/bootstrap.sh`, `.env.example`,
  `fly-eu.toml`, `fly-us.toml`, `fly-web-eu.toml`, `fly-web-us.toml`,
  `README.md`, `.github/workflows/deploy-fly.yml` (the bare `default: "X.Y.Z"`),
  `e2e/hot-policy-reload.live.e2e.ts`, `e2e/mcp-proxy.live.e2e.ts`.
  (`.env.self-host.example` is not a pin site: self-host process-spawns the
  in-image compiled binary, so it carries no image tag.)

The engine itself is at `engine/` and ships its own image via the `engine-v*`
publish workflow; the merge centralizes the pin but does not remove it (the
control plane still references the engine by tag). The sanity grep still works:
`rg 'midplane/midplane:[0-9]' --hidden -g '!node_modules' -g '!bun.lock'`.

Self-host carries no image pin: it process-spawns the in-image compiled binary
(`ProcessSpawner`, selected by `MIDPLANE_SELF_HOST=1` in `mcp-proxy.ts`; the
binary is bundled by `Dockerfile.self-host` and built standalone via
`scripts/build-engine-binary.sh`). The pin governs only the cloud (Fly-machine)
and local-dev (Docker) spawn paths; prod pins the immutable digest
(`@sha256:...`) in the Fly TOMLs.

## Commit & PR conventions

Commit messages and PR titles follow [Conventional Commits](https://www.conventionalcommits.org):
`type(scope): description` (e.g. `feat(audit): connection-scoped audit log`).
Common types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`, `security`. Sign commits with `git commit -s` (DCO — see
`CONTRIBUTING.md`). Keep PRs focused and explain the "why" in the description.
