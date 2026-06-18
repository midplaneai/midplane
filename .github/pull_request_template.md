## What & why

<!-- What does this change, and why? Link the issue, bypass class, or user-visible effect. -->

## Checklist

- [ ] PR title follows [Conventional Commits](https://www.conventionalcommits.org) (`type(scope): description`)
- [ ] Commits are signed off (`git commit -s` — DCO, see CONTRIBUTING.md)
- [ ] Change is focused; the "why" is explained above
- [ ] Tests pass: `./node_modules/.bin/vitest run` (control plane) and/or `bun run test:engine` (engine)
- [ ] Typecheck + lint pass: `(cd apps/web && bun run typecheck && bun run lint)`
- [ ] Open-core boundary respected: MIT core does not import from `apps/web/src/ee/`
- [ ] Docs updated if behavior changed (README, `engine/TELEMETRY.md`, `engine/THREAT_MODEL.md`, etc.)
- [ ] If telemetry payloads changed: `engine/TELEMETRY.md` updated and `schema_version` bumped
