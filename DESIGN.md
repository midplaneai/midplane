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
- **UI/Labels:** Geist Mono 500 11.5px lowercase tracking-[0.04em]. See "Voice split" below.
- **Data/Tables:** Geist Mono with `font-feature-settings: 'tnum'`. 11–12px.
- **Code:** Geist Mono. Same family as data so they harmonize.
- **Loading:** `next/font/google` from root layout. Both fonts have CSS variables (`--font-geist`, `--font-geist-mono`) so Tailwind can reference them.
- **Scale (px):**
  - Page title: 22 (table/dashboard pages), 30 (focused single-task pages like onboarding), 48–64 (landing hero only)
  - H2 / section: 16–18
  - Body: 13–15
  - Caption / label: 11.5 mono lowercase, tracking-[0.04em] in product; 11–12 mono UPPERCASE in landing eyebrows.

### Voice split (case matters)
- **Product = lowercase mono.** Form-field labels, sidebar section labels, pane/section eyebrows (`project`, `database`, `policy`, …), table column headers, breadcrumb segments, audit metadata keys, card titles all render in Geist Mono lowercase at 11.5px. Source text can be any case ("Name", "DATABASE_URL") — the visual lowercase is a CSS `text-transform`, so screen readers still announce the canonical form.
- **Landing = UPPERCASE mono.** `.eyebrow`, `.ba-tag`, `.flow-setup-label`, section numbers (`.sec-num`) stay uppercase — this is the editorial voice. Do not lowercase landing eyebrows when touching landing markup.
- **Acronyms / region codes stay uppercase.** `EU`, `US` in the `RegionBadge` are rendered via `region.toUpperCase()`. They are codes, not labels.
- **SQL keywords in mixed labels stay UPPERCASE.** When a generated label mixes SQL tokens with prose ("DELETE / UPDATE with no WHERE", "DML with no WHERE blocked"), the keywords/acronyms keep caps and the prose + identifiers stay lowercase — all-lowercase hid which words were SQL ("with no where" read as English). Whole-label uppercase remains an anti-pattern; pure action labels with no prose ambiguity ("delete from orders" probe rows) stay lowercase, and literal SQL sent to the engine or typed by the user is never re-cased.

### Bold emphasis in prose
Help text and descriptions bold the load-bearing phrase via `<strong className="font-medium text-foreground">`. **Budget: one `<strong>` per paragraph.** Reserve for: security guarantees ("never persist the plaintext"), recommended defaults ("Recommended."), and hard warnings ("All tokens on this connection are revoked."). Not for general emphasis.

## Color
- **Approach:** Restrained. One accent (`#4a78ff`) plus three semantic colors that map to product mechanics. Everything else is neutral grays.

### Surfaces (warm dark — dark twin of editorial paper)
| CSS token | Value | Use |
|---|---|---|
| `--background` | `#161412` | Page background. Same hue family as the landing's `--ink`. |
| `--card` | `#1c1916` | Elevated card / sidebar |
| `--popover` / `--secondary` / `--muted` / `--accent` | `#221f1c` | Inputs (autofill pinned to `--background`), secondary buttons, filter chips, hover surfaces |
| `--border` | `#2a2622` | Default hairline |
| `--border-strong` | `#403c36` | Hover / focus border |

### Text
| Token (CSS) | Tailwind | Value | Use |
|---|---|---|---|
| `--foreground` | `text-foreground` | `#f3efe7` | Primary text, headings, key data. Exact match to landing `--paper`. |
| `--muted-foreground` | `text-muted-foreground` | `#bdb4a6` | Body / secondary text — descriptions, prose, form helper text. Must clear WCAG AA. |
| `--subtle` | `text-subtle` | `#a39a8c` | Tertiary only — sidebar section labels, table column headers, timestamps, breadcrumb segments, footer metadata. |
| `--placeholder` | — | `#7a7268` | Input placeholders. Used directly via `placeholder:text-[hsl(var(--placeholder))]`. |

### Accent + Semantic
| Token | Value | Use |
|---|---|---|
| `--brand` (alias `--ring`) | `#1d4eff` | **Decorative surfaces only** — the wordmark colon, the two-dot workspace mark, the 3px selection rail (sidebar / radio / row), focus rings, the selected native radio dot. **Never** on body text or links < 18px. Matches the landing's `--accent-blue` exactly so the brand reads as one across marketing and product. |
| `--allow` | `#5a9c6e` | Allowed query, success, live freshness dot. Dark-tuned for AA on `--background`; not the saturated paper value (`#1f6f47`). |
| `--deny` | `#c87070` | Denied query, error, destructive intent. Dark-tuned. |
| `--warn` | `#d4a04c` | Staleness, warnings, anomaly flags. |
| `--deny-tint` | `hsl(var(--deny) / 0.06)` | Audit-log deny-row background (subtle blush, no border). |

Each semantic color is used with `hsl(var(--name) / 0.08)` for badge/banner fills (Tailwind's arbitrary-value alpha syntax — no separate `--{name}-bg` tokens).

### Region — "where data lives"
First-class tokens, intentionally distinct from semantic `--allow`/`--deny` so a region badge can't be misread as a policy outcome.

| Token | Value | Use |
|---|---|---|
| `--region-eu` | `#4099bf` | EU residency badge |
| `--region-us` | `#db8e47` | US residency badge |

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
- **Border radius (mixed scale — spec-sheet feel):**
  - `0` — cards, panels, radio rows, inputs, dropdowns, sheets, alert dialogs (everything rectangular).
  - `3px` — pills and badges only.
  - `6px` — buttons. Matches the landing's `.ebtn` so the primary CTA reads as the same control across `/` and `/dashboard`.
  - `50%` — avatars and icon-only buttons (`<Button size="icon">`).
  - Implementation: `--radius: 0` in `globals.css`. Tailwind's `rounded-lg`/`md`/`sm` therefore all collapse to `0`. Buttons opt back in with explicit `rounded-[6px]`; badges with `rounded-[3px]`; round elements with `rounded-full`. Don't reintroduce a non-zero `--radius`.
- **Hairlines, not shadows.** `1px solid var(--border)`. No `box-shadow` on cards. The 3px selection rail on active rows / radio cards / sidebar items is the one accepted use of `box-shadow` (inset, brand). Elevation comes from the surface ramp (`--background` → `--card` → `--popover`), not blur.

## Motion
- **Approach:** Minimal-functional. The only motion that ships by default is the freshness pulse and spinners.
- **Easing:** `ease-out` for enter, `ease-in` for exit, `ease-in-out` for state transitions.
- **Duration:** 50–100ms for micro (hover, focus), 150–250ms for short (modal/drawer), 250–400ms for medium (page-level transitions).
- **The pulse:** `@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }` at 2s on `--allow`-colored 6×6px dots. Use sparingly — only for "live" / "fresh" signals.
- **Honor `prefers-reduced-motion`** on every animated element.

## Brand Mark
**The wordmark is the mark.** Text-only, rendered inline as
`mid<span class="mp-colon">:</span>plane`. The colon — Geist 700, blue
`#1d4eff` — is the brand. The letters are Geist 600, letter-spacing
`-0.022em`. On dark surfaces the letters flip to paper (`#f3efe7`) and the
colon stays blue.

Always render the wordmark as inline text — never an `<img>` of `wordmark.svg`
— so it scales with the user's font size, supports selection, and announces
correctly. The screen reader text is "midplane" (no colon) via `aria-label`
on the wrapping `<a>`/`<span>`.

In plain-text contexts (`<title>`, `og:*`, URLs, CLI, env vars, filenames)
write **Midplane** with no colon. The colon is a typesetting choice for the
brand mark, not a renaming of the product.

### Implementation
- `Wordmark` (alias `BrandLockup`) in
  `apps/web/src/components/layout/brand-mark.tsx` is the canonical React
  primitive. Pass `onDark` for the inverted (paper letters) variant.
- `.mp-wordmark` / `.mp-colon` utilities live in `globals.css`. The colon
  picks up `hsl(var(--brand))` on the dark app and `var(--accent-blue)`
  inside `.editorial-page`. As of 2026-05-22 both resolve to the same
  literal `#1d4eff` — there is one brand blue, applied per medium.
- The colon motif is also rendered as the **two-dot mark** in the sidebar
  workspace switcher (two 5×5 blue dots, 3px gap) — see
  `WorkspaceMark()` in `app-shell.tsx`. Treat that mark as a brand
  surface; do not recolor it or repurpose it for non-workspace contexts.

### Icon system (square surfaces only)
The square icon (`apps/web/public/brand/icon.svg` — ink square + blue colon,
punched) is for favicon, app icon, OG card corner, Slack workspace, GitHub
avatar. Do not place the square icon next to the wordmark in topbars or
footers — the wordmark stands alone there. Inverted (`icon-inverted.svg`)
and mono (`icon-mono.svg`) variants are available for dark close bands and
single-colour print.

The bare colon (`icon-bare.svg` — two blue dots, no frame) may additionally
render in-page where an app-icon semantic is needed inside the product: the
one approved use is the identity chip on the OAuth consent screen's
agent → midplane handshake. It stays subject to the topbar/footer rule above
and is not a general-purpose decoration.

The previous four-quadrant window-mullion `.mark` glyph has been retired.

## Component Conventions
- **Buttons:** Primary = `bg-primary text-primary-foreground` (paper on ink). 6px radius. Optional `arrow` prop appends a Geist Mono `→` after children — pass on form submits, mirrors the landing's `.ebtn.fill` hero CTA. Secondary = `bg-secondary border-border`. Destructive uses `--deny`. Icon size variant is `rounded-full`. No gradient buttons. No oversized primary CTAs.
- **Inputs:** 40px tall, `bg-background` (or `bg-muted` for readonly), `border-input`, **`rounded-none`**, placeholder uses `--placeholder`, focus ring `--ring` (which is `--brand`). Autofill is pinned to `--background` so Chrome doesn't paint pale lavender.
- **Tables:** Header text in `font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle` (use the `Th` helper in `audit/page.tsx` as the reference). 12px body in `--foreground`, hover row in `--card`. Row borders in `--card` (subtle), table header border in `--border` (visible). **Deny rows** carry a `hsl(var(--deny) / 0.06)` background tint and a heavier hover tint.
- **Badges:** 10px uppercase mono, 3px radius, with a 4×4px dot when semantic. Allow/deny/warn pulled from semantic tokens. Region badges (`EU`/`US`) use `--region-eu`/`--region-us`. Badges keep UPPERCASE because they're status codes / acronyms, not labels.
- **Breadcrumb:** `Breadcrumb` primitive in `components/ui/breadcrumb.tsx`. API: `<Breadcrumb items={[{ label, href? }, ...]} />`. Renders lowercase mono with a blue colon (`--brand`) separator (`aria-hidden`). Last item gets `aria-current="page"`. Always ship the primitive — do not inline `<Link>/<span>/`.
- **Empty states:** Dashed border in `--border`, padding 40px+, title in `--foreground`, body in `--muted-foreground`. `rounded-none`.
- **Selection rail:** Active sidebar items, selected `AccessRadio` cards, and selected table rows all signal selection with `box-shadow: inset 3px 0 0 hsl(var(--brand))`. No full outlines, no background bumps. This is the one accepted use of `box-shadow` on flat surfaces.
- **Sheet:** Right-side slide-in dialog (`components/ui/sheet.tsx`) for non-blocking secondary surfaces — agent setup, side detail. 480px wide on desktop (`md:w-[480px]`); full-screen below the `md` breakpoint (768px). Backdrop is `bg-background` at 60% opacity. Header / Body / Footer slots; body is the only scrolling region. Slide animation honors `prefers-reduced-motion` via the `motion-safe:` Tailwind variant. Use Sheet — not AlertDialog or a modal — when the user can keep the underlying page in mind. Reach for AlertDialog only for destructive confirmations.

## Anti-patterns (do not do)
- Purple/violet gradients
- Centered hero with 3-column icon-in-circle feature grid
- Drop shadows on cards (the 3px inset rail on selected surfaces is the only `box-shadow` permitted)
- Light backgrounds in the authenticated app
- Any non-zero `border-radius` on cards / panels / inputs / dropdowns / sheets (buttons keep 6px, badges 3px, round elements 50% — that is the whole scale)
- `Inter` or `Roboto` as a primary face — we are on Geist
- Adding a fourth semantic color (allow/deny/warn is the vocabulary)
- Using `--brand` (`#1d4eff`) on body text or links < 18px (decorative surfaces only)
- Folding region colors into semantic (`--region-eu` is teal, not `--allow` green) — two perceptual axes, two color families
- Uppercase labels in product chrome (lowercase mono is the runtime voice). UPPERCASE stays on landing eyebrows only.

## Decisions Log
| Date | Decision | Rationale |
|---|---|---|
| 2026-04-29 | Initial midplane token system + 3 page mockups (landing, audit dashboard, onboarding) | Manual design exploration via /design-shotgun + /design-html. Locked palette and type. |
| 2026-04-30 | Adopted as canonical via /design-consultation; written into DESIGN.md | Existing tokens were already coherent and partially shipped (audit page). Goal: stop the design drift, propagate everywhere. |
| 2026-04-30 | Split `text-1` (body) from `text-2` (tertiary): `--muted-foreground` is now `#b4b4b4`; new `--subtle` at `#707070` for labels/timestamps. Added lucide icons to sidebar. Added `:-webkit-autofill` rule to keep `Input` bg dark in Chrome. | First-pass review caught body copy at 4:1 contrast, sidebar reading as broken icons, password input rendering pale lavender on autofill. |
| 2026-05-20 | Brand accent retuned: `--brand` / `--ring` moved from `#6cb6ff` (info-blue cyan) to `#4a78ff` (saturated blue, hue 225°). Brand mark redrawn as a window-mullion (square + 1px cross slits) matching the editorial landing. | Landing's `#1d4eff` and the app's `#6cb6ff` read as different brand colors. Unified the hue across both — landing keeps `#1d4eff` on paper; the app uses a 9-point-lighter cousin tone-mapped for AA contrast on `#0a0a0a`. Mark swap unifies the glyph between marketing and app surfaces. |
| 2026-05-22 | Adopted the locked-in `midplane-brand` package (see `apps/web/public/brand/`). Wordmark becomes `mid:plane` with a blue colon — the wordmark is now the mark on light/auth chrome, no separate icon glyph beside it. Four-quadrant window-mullion `.mark` retired. Square `icon.svg` (ink + blue colon) reserved for favicon / OG / Slack / GitHub. Favicons + OG meta wired in `app/layout.tsx`. | Brand exploration converged on "the colon is the brand" — a single, distinctive typesetting move instead of a separate glyph that competes with the wordmark. Keeping the wordmark text-based (not an `<img>`) preserves font scaling, selection, and accessibility. |
| 2026-05-22 | Re-skin to warm dark. Adopted `#161412` background (warm-dark twin of the landing's `--ink`). Mono lowercase on field labels, sidebar section labels, table column headers, and breadcrumb segments. Colon separator in breadcrumb (`<Breadcrumb>` primitive). Region colours promoted to first-class tokens (`--region-eu` / `--region-us`); kept distinct from semantic allow/deny. Mixed radius: 0 on cards / inputs / panels, 6px on buttons (matches landing `.ebtn`), 3px on badges, 50% on avatars. Accent (`#1d4eff`) restricted to decorative surfaces — colon, two-dot mark, 3px selection rail, focus rings, selected radio dot — never on small text. Dark-tuned semantic values (`#5a9c6e`, `#c87070`) kept; not replaced with paper literals (`#1f6f47`, `#c4321e`) which read muddy on dark. Two-blue-dots `WorkspaceMark` replaces the lucide `Building2` in the sidebar workspace switcher. Active sidebar / radio / row selection is a 3px inset rail (`box-shadow`) instead of a full outline. Help text bolds one load-bearing phrase per paragraph (security guarantee / recommended default / hard warning). Clerk theme hex re-pinned to match (Clerk doesn't read CSS custom properties). | Marketing and product had the same logo but read as different companies — cold-charcoal SaaS vs warm-paper editorial. Re-skin closes the gap by making the product the dark twin of the landing palette, not a separate aesthetic. Accent stays the literal landing blue (rather than the AA-lifted `#4a78ff`) because the brand restriction (decorative only) means small-text contrast isn't the deciding constraint; verified AA holds for body / muted-body against the new `--background`. |
| 2026-07-08 | Normalized the project-workspace section eyebrows (`project`, `database`, `policy`, `actions`, `pii exposure`, `masked preview`) from 10px UPPERCASE sans to the standard lowercase-mono label token (`font-mono 11.5px lowercase tracking-[0.04em] text-subtle`). | Two micro-label voices had drifted into one view (the eyebrows disagreed with the breadcrumb/sidebar beside them, and with each other on tracking). Lowercase mono is the documented runtime voice; 45 sites conformed vs 6 drifted. Badges, acronyms/region codes, and SQL keywords keep UPPERCASE per the existing exceptions. |
