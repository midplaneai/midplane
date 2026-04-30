# Design System — Midplane

The single source of truth for visual decisions. Read this before changing anything
that renders. The token values here mirror those mocked up in
`~/.gstack/projects/midplaneai-midplane/designs/midplane-tokens.css` and applied in
`apps/web/src/app/globals.css`.

## Product Context
- **What this is:** A safety layer between AI coding agents (Cursor, Claude Code) and Postgres. Parses SQL via AST, denies destructive writes by default, audits everything.
- **Who it's for:** Technical, security-conscious developers and small teams. People who paste `DATABASE_URL`s into things and want to sleep at night.
- **Space/industry:** Developer infrastructure. Neighbors: Linear, Vercel, PlanetScale, Supabase, Stripe Workbench.
- **Project type:** Hosted control plane (Next.js dashboard) + CLI/MCP runtime. The marketing landing and the authenticated app live in the same Next.js app.

## Aesthetic Direction
- **Direction:** Dense, dark, infra-tool. No decoration that doesn't earn its pixels.
- **Decoration level:** Minimal. Subtle 60px×60px grid background at `rgba(255,255,255,.018)` opacity is the only ornament. Borders, never shadows, separate surfaces.
- **Mood:** "Read the source before you paste a connection string." A real ops tool, not onboarding software. Confidence without being clever.
- **Reference systems:** Linear (density), Vercel (typographic precision), PlanetScale (table-first), Stripe Workbench (semantic color).

## Typography
- **Display/Hero:** Geist 600–700, `letter-spacing: -0.025em` to `-0.035em`.
- **Body:** Geist 400, 13–15px depending on context (13px in tables, 14–15px in prose).
- **UI/Labels:** Geist 500, 11–13px.
- **Data/Tables:** Geist Mono with `font-feature-settings: 'tnum'`. 11–12px.
- **Code:** Geist Mono. Same family as data so they harmonize.
- **Loading:** `next/font/google` from root layout. Both fonts have CSS variables (`--font-geist`, `--font-geist-mono`) so Tailwind can reference them.
- **Scale (px):**
  - Page title: 22 (table/dashboard pages), 30 (focused single-task pages like onboarding), 48–64 (landing hero only)
  - H2 / section: 16–18
  - Body: 13–15
  - Caption / label: 11–12, often `text-transform: uppercase`, `letter-spacing: 0.04em`

## Color
- **Approach:** Restrained. One accent (`#6cb6ff`) plus three semantic colors that map to product mechanics. Everything else is neutral grays.

### Surfaces
| Token | Value | Use |
|---|---|---|
| `--bg-0` | `#0a0a0a` | Page background |
| `--bg-1` | `#111111` | Elevated card / sidebar |
| `--bg-2` | `#161616` | Inputs, secondary buttons, filter chips |
| `--bg-3` | `#1d1d1d` | Active / pressed state, code blocks |
| `--border` | `#232323` | Default hairline |
| `--border-strong` | `#2e2e2e` | Hover / focus border |

### Text
| Token (CSS) | Tailwind | Value | Use |
|---|---|---|---|
| `--foreground` | `text-foreground` | `#f5f5f5` | Primary text, headings, key data |
| `--muted-foreground` | `text-muted-foreground` | `#b4b4b4` | Body / secondary text — descriptions, prose, form helper text. Must clear WCAG AA. |
| `--subtle` | `text-subtle` | `#707070` | Tertiary only — sidebar section labels, table column headers, timestamps, breadcrumb separators, footer metadata. Below AA on purpose; never use for body copy. |

### Accent + Semantic
| Token | Value | Use |
|---|---|---|
| `--accent` | `#6cb6ff` | Links, focus rings, active nav indicator, "key" highlights in code |
| `--allow` | `#5a9c6e` | Allowed query, success, live freshness dot |
| `--deny` | `#c87070` | Denied query, error, destructive intent |
| `--warn` | `#d4a04c` | Staleness, warnings, anomaly flags |

Each semantic color also has a paired `--{name}-bg` at ~8% alpha for badge/banner fills (`rgba(90, 156, 110, 0.08)` etc.).

- **Dark mode:** This IS dark mode. There is no light mode for the authenticated app. Marketing pages may go light in the future; if so, redesign — do not algorithmically invert.

## Spacing
- **Base unit:** 4px.
- **Density:** Compact. Match Linear / Vercel, not Notion.
- **Scale (Tailwind defaults are fine):** 1 (4) · 2 (8) · 3 (12) · 4 (16) · 5 (20) · 6 (24) · 8 (32) · 12 (48) · 16 (64) · 20 (80).
- **Page padding:** 24px on dashboard/list pages, 28–48px on focused single-task pages.
- **Max content width:** 1280px for table/dashboard pages, 760px for forms / focused tasks, 920px for editorial / landing sections.

## Layout
- **Approach:** Grid-disciplined for app, editorial for marketing.
- **App shell:** 220px sidebar + 1fr main, 48px topbar with breadcrumb. Mobile: sidebar hidden below 960px.
- **Border radius:** 3 (small badges/chips) · 4 (filter buttons) · 6 (buttons, inputs) · 8 (banners, code blocks) · 10–12 (cards, large containers) · 100px (eyebrow pills only).
- **Hairlines, not shadows.** `1px solid var(--border)`. No `box-shadow` on cards. Elevation comes from background ramp (`--bg-0` → `--bg-1`), not blur.

## Motion
- **Approach:** Minimal-functional. The only motion that ships by default is the freshness pulse and spinners.
- **Easing:** `ease-out` for enter, `ease-in` for exit, `ease-in-out` for state transitions.
- **Duration:** 50–100ms for micro (hover, focus), 150–250ms for short (modal/drawer), 250–400ms for medium (page-level transitions).
- **The pulse:** `@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }` at 2s on `--allow`-colored 6×6px dots. Use sparingly — only for "live" / "fresh" signals.
- **Honor `prefers-reduced-motion`** on every animated element.

## Brand Mark
A 16–18px notched square. CSS:
```css
clip-path: polygon(0 0, 100% 0, 100% 65%, 65% 100%, 0 100%);
background: var(--text-0);
```
Renders inline next to the wordmark "midplane" (lowercase, Geist 600, `letter-spacing: -0.01em`).

## Component Conventions
- **Buttons:** Primary = `bg-foreground text-background`. Secondary = `bg-secondary border-border`. Destructive uses `--deny`. No gradient buttons. No oversized primary CTAs.
- **Inputs:** 40px tall, `bg-background` (or `bg-muted` for readonly), `border-input`, `rounded-md`, focus ring `--ring` (which is `--accent`).
- **Tables:** 11px uppercase header text in `--text-2`, 12px body in `--text-1`, hover row in `--bg-1`. Row borders in `--bg-1` (subtle), table header border in `--border` (visible).
- **Badges:** 10px uppercase mono with a 4×4px dot when semantic. Allow/deny/warn pulled from semantic tokens.
- **Empty states:** Dashed border in `--border`, padding 40px+, title in `--text-0`, body in `--text-2`.

## Anti-patterns (do not do)
- Purple/violet gradients
- Centered hero with 3-column icon-in-circle feature grid
- Drop shadows on cards
- Light backgrounds in the authenticated app
- Bubbly oversized border-radius (>12px on rectangular surfaces)
- `Inter` or `Roboto` as a primary face — we are on Geist
- Adding a fourth semantic color (allow/deny/warn is the vocabulary)

## Decisions Log
| Date | Decision | Rationale |
|---|---|---|
| 2026-04-29 | Initial midplane token system + 3 page mockups (landing, audit dashboard, onboarding) | Manual design exploration via /design-shotgun + /design-html. Locked palette and type. |
| 2026-04-30 | Adopted as canonical via /design-consultation; written into DESIGN.md | Existing tokens were already coherent and partially shipped (audit page). Goal: stop the design drift, propagate everywhere. |
| 2026-04-30 | Split `text-1` (body) from `text-2` (tertiary): `--muted-foreground` is now `#b4b4b4`; new `--subtle` at `#707070` for labels/timestamps. Added lucide icons to sidebar. Added `:-webkit-autofill` rule to keep `Input` bg dark in Chrome. | First-pass review caught body copy at 4:1 contrast, sidebar reading as broken icons, password input rendering pale lavender on autofill. |
