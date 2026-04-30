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
