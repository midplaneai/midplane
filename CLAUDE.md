# Claude operating notes — midplane-cloud

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

## OSS image version pin sites

The OSS engine image version (`midplane/midplane:X.Y.Z`) is pinned in
seven places. Bumping requires updating all of them or the dev loop and
prod deploys diverge from what the cloud was tested against:

- `scripts/dev-image.sh` — local build tag
- `scripts/bootstrap.sh` — one-shot setup script
- `.env.example` — documented default
- `packages/router/src/spawner-docker.ts` — fallback when env unset
- `packages/router/src/spawner-fly.ts` — fallback when env unset
- `fly-fra.toml` (and any sibling regional `fly-*.toml`) — production
- `README.md` — docs

Plus the test fixture in `packages/router/test/spawner-docker.test.ts`
asserts on the tag, so it gets re-pinned to match.

Sanity-check grep before declaring a bump done:
`rg 'midplane/midplane:[0-9]' --hidden -g '!node_modules' -g '!bun.lock'`

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the
Skill tool as your FIRST action. Do NOT answer directly, do NOT use other tools
first. The skill has specialized workflows that produce better results than
ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
