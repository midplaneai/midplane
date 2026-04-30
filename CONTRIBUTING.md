# Contributing to Midplane

Thanks for the interest. This project earns trust by what it catches and what it doesn't pretend to catch — the most valuable contributions are SQL bypass attempts (and the policy fixes that defeat them).

## TL;DR

- **Found a SQL shape that bypasses a policy?** Open a PR adding a row to [`docs/adversarial-corpus.md`](./docs/adversarial-corpus.md) and a matching test in [`packages/engine/test/adversarial/`](./packages/engine/test/adversarial). That is the highest-leverage contribution to the project.
- **Found a security vulnerability?** Don't open a public issue. See [SECURITY.md](./SECURITY.md).
- **Other PRs welcome too** — bugs, docs, agent compatibility, perf. The bar is the same: tests, real reproduction, no regressions.

## Dev setup

```bash
bun install
bun test                    # policy + adversarial corpus + telemetry
bun run smoketest           # end-to-end against sidecar Postgres (Docker required)
```

`bun >= 1.3` is required; we don't test against Node directly.

## Adding an adversarial-corpus entry

The corpus is a one-to-one mirror: every row in [`docs/adversarial-corpus.md`](./docs/adversarial-corpus.md) maps to one assertion in [`packages/engine/test/adversarial/`](./packages/engine/test/adversarial). The doc is what humans review; the tests are what CI gates on.

A typical bypass-attempt PR has three pieces:

1. **A new row in the markdown table** under the right rule section. Include the SQL, the verdict (DENY or ALLOW), the rule name, and a one-line "why this matters."
2. **A new test in the matching file** (`writes-recursive.test.ts`, `multi-statement.test.ts`, `tenant-scope.test.ts`, `parse-edges.test.ts`, or `exec-side-effects.test.ts`). Use the `expectDeny` / `expectAllow` helpers from `_helpers.ts`.
3. **A policy fix, if the test currently fails.** Run `bun test` to confirm the new assertion fails on `main`, then change `packages/engine/src/policy/*` until it passes — without breaking any of the other 100+ corpus entries.

If you find a bypass and don't know how to fix it, open the PR with just the failing test plus the markdown row. We treat that as a release blocker and will pick it up.

## PR checklist

- [ ] Tests pass (`bun test`)
- [ ] Adversarial-corpus markdown and tests stay in sync (one row in the doc → one assertion)
- [ ] Policy changes preserve the four V1 rules' contract; if you tightened one, add an entry to the corpus showing what's now denied
- [ ] No new fields added to telemetry payloads without updating [`TELEMETRY.md`](./TELEMETRY.md) and bumping `schema_version`
- [ ] Docs touched if behavior changed (`README`, `docs/self-host.md`, `docs/agent-setup.md`, `TELEMETRY.md`, `THREAT_MODEL.md`)
- [ ] Commit messages reference the WHY (the issue, the bypass class, the user-visible effect) over the WHAT

## DCO

Sign your commits with `git commit -s`. By signing, you certify the [Developer Certificate of Origin](https://developercertificate.org/) — you wrote the change or have the right to submit it under the project's MIT license. We don't require a separate CLA.

## License

The project is and stays MIT. By contributing you agree your contribution is licensed the same way.

## Scope guidance for V1

Some things are deliberately out of scope until V1.5+ (write-approval flow, function-side-effects denylist, session-scope tracking, column-level reads). PRs that add those should reference the [Roadmap](./README.md#roadmap) so we can stage them. Smaller fixes inside the V1 surface are easier to land.
