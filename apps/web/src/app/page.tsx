// Marketing landing page — editorial paper theme (light).
//
// Ports the 02-editorial-v2.html design from claude.ai/design. The dark
// dashboard is unchanged; this page sets its own paper palette via
// .editorial-page in globals.css.
//
// Hero variant: Before/After. The persisted variant in the source design
// file. The display-headline editorial variant is preserved in design,
// not in code — flip the hero if you want to A/B.
//
// Content-truth audit. Each claim cross-checked against the repo and
// PRICING.md. Items still soft-pending:
//   • Quickstart "~60s" timing — aspirational; confirm against the
//     actual signup → first-query flow.
//   • Teams member list shows Google + Okta SAML sign-ins — illustrative;
//     PRICING.md gates SSO/SAML at Team tier.
//   • Audit table sample agent versions (cursor v0.45, claude-code 1.2)
//     — illustrative.
//   • KMS EncryptionContext key name "workspace_id" — confirm matches
//     the actual context key used in packages/kms.
//   • §03 vs roles → §04 Teams: per-query engineer attribution is NOT
//     shipped (MCP tokens are per-customer, not per-engineer). The page
//     no longer claims it. If multi-token-per-connection ships, swap §04
//     back to a member-with-tokens table.
import { auth } from "@clerk/nextjs/server";
import Link from "next/link";

import { DemoChat } from "./demo/demo-chat";

export default async function Landing() {
  // Signed-in users still see the landing — they may be sharing it with
  // teammates, revisiting the pricing page, or comparing tier limits.
  // Topbar swaps the Sign in / Start free pair for a Dashboard link so
  // they have a one-click way into the app from here.
  const { userId } = await auth();
  const isSignedIn = !!userId;

  return (
    <main className="editorial-page">
      <div className="page">
        <header className="topbar">
          <div className="brand">
            <span className="mark" aria-hidden />
            <span>midplane</span>
          </div>
          <nav className="nav">
            <a href="#how">Product</a>
            <a href="#policy">Policy</a>
            <a href="#audit">Audit</a>
            <a href="#hosted">Hosted</a>
            <a href="#pricing">Pricing</a>
            <a href="#quickstart">Quickstart</a>
          </nav>
          <div className="topright">
            <a href="#hosted" className="mono">
              EU + US ●
            </a>
            <a href="https://github.com/midplaneai/midplane">GitHub</a>
            {isSignedIn ? (
              <a className="ebtn fill" href="/dashboard">
                Dashboard →
              </a>
            ) : (
              <>
                <Link href="/sign-in">Sign in</Link>
                <Link className="ebtn fill" href="/sign-up">
                  Start free
                </Link>
              </>
            )}
          </div>
        </header>

        {/* Enablement hero — productivity promise. The BA pair (postmortem
            story) was here; it's now §01 "What changes" as a demonstration
            rather than the lead. */}
        <section className="hero-pri">
          <div className="eyebrow">
            <span className="dot" aria-hidden />
            <span>Access layer for your existing Postgres</span>
            <span className="sep" aria-hidden />
            <span>v0.5.0 · EU + US</span>
          </div>

          <h1 className="pri-h1">
            Production Postgres access for <em>your AI agents.</em>
          </h1>

          <div className="ba-foot">
            <div>
              <p className="lede">
                Midplane sits in front of your existing Postgres and{" "}
                <strong>bounds what each query can do</strong>. Your
                engineers&apos; agents get to read prod safely, build
                dashboards from chat, and debug live — work that
                wasn&apos;t safe to give an agent yesterday.
              </p>
              <div className="hero-ctas">
                <Link className="ebtn fill" href="/sign-up">
                  Start free →
                </Link>
                <span className="cmd">
                  no credit card · <b>free for 1 connection · 1 seat</b>
                </span>
              </div>
            </div>
            <div className="hero-meta">
              <div className="row">
                <span>Your database</span>
                <b>stays where it is</b>
              </div>
              <div className="row">
                <span>Databases per instance</span>
                <b>many · prod + staging + …</b>
              </div>
              <div className="row">
                <span>Audit log</span>
                <b>append-only</b>
              </div>
            </div>
          </div>
        </section>

        {/* Embedded "try it" pane — live demo placed right after the
            hero so the promise lands before the editorial unpacks it.
            Intentionally unnumbered: the dark frame reads as a product
            surface inside the light editorial flow, not as part of
            the §01..§04 spine. */}
        <section className="sec demo-sec" id="try">
          <div className="sec-top">
            <div className="sec-num">
              <b>—</b>Try
            </div>
            <div>
              <h2 className="sec-h">
                Ask the database. Watch the policy decide.
              </h2>
              <p className="sec-sub">
                Pick an example. Flip a table&apos;s access level. Re-pick
                to watch the decision change.
              </p>
            </div>
          </div>
          <div className="demo-pane">
            <DemoChat />
          </div>
        </section>

        {/* §01 — What changes. The same query an engineer's agent might
            run, with and without midplane. Was the hero; demoted to a
            section so the hero can lead on enablement. */}
        <section className="sec">
          <div className="sec-top">
            <div className="sec-num">
              <b>01</b>What changes
            </div>
            <div>
              <h2 className="sec-h">
                Same agent. Same Postgres.{" "}
                <em>One ends in a postmortem.</em>
              </h2>
              <p className="sec-sub">
                The same query your engineer&apos;s agent might run on a
                Tuesday morning, with and without midplane in front of
                Postgres.
              </p>
            </div>
          </div>
          <div className="ba-pair">
            <article className="ba-card bad">
              <div className="ba-tag">
                <span className="dot" aria-hidden />
                <span>Without midplane</span>
                <span className="ts mono">tue 09:17:34</span>
              </div>
              <h2 className="ba-claim">
                Production gone in <em>nine seconds.</em>
              </h2>
              <pre className="ba-query">
                <span className="com"># cursor agent, cleaning up stale rows</span>
                {"\n"}WITH cleanup AS ({"\n"}{"  "}DELETE FROM users{"\n"}{"  "}RETURNING *{"\n"}){"\n"}SELECT count(*) FROM cleanup;
              </pre>
              <div className="ba-arrow">runs against your Postgres</div>
              <div className="ba-outcome bad">
                <div className="o-head">
                  <span>postgres · prod</span>
                  <span>0.9 s</span>
                </div>
                users · <b className="d">41,802 rows deleted</b>
                <br />
                production: <b className="d">gone</b>
              </div>
              <div className="ba-epilogue">
                09:18 — <b>#incidents · sev1</b> · &ldquo;what happened?&rdquo;
              </div>
            </article>

            <article className="ba-card good">
              <div className="ba-tag">
                <span className="dot" aria-hidden />
                <span>With midplane</span>
                <span className="ts mono">tue 09:17:34</span>
              </div>
              <h2 className="ba-claim">
                Denied <em>before it runs.</em>
              </h2>
              <pre className="ba-query">
                <span className="com"># same agent, same query</span>
                {"\n"}WITH cleanup AS ({"\n"}{"  "}DELETE FROM users{"\n"}{"  "}RETURNING *{"\n"}){"\n"}SELECT count(*) FROM cleanup;
              </pre>
              <div className="ba-arrow">hits midplane policy first</div>
              <div className="ba-outcome good">
                <div className="o-head">
                  <span>midplane · policy</span>
                  <span>table_access</span>
                </div>
                <b className="d">DENIED</b> ·{" "}
                <span className="mono">users</span> is not in the opt-in write
                list
                <br />
                the <span className="mono">DELETE</span> in the CTE was caught
                at parse time
              </div>
              <div className="ba-epilogue">
                09:17 — <b>audit logged</b> · agent pivots to a{" "}
                <span className="mono">SELECT</span>
              </div>
            </article>
          </div>
        </section>

        {/* §02 — How it works */}
        <section className="sec" id="how">
          <div className="sec-top">
            <div className="sec-num">
              <b>02</b>How it works
            </div>
            <div>
              <h2 className="sec-h">
                One-time setup. <em>Three checkpoints, every query.</em>
              </h2>
              <p className="sec-sub">
                You hand the agent a Midplane URL once. From then on, every
                query the agent runs is checked, logged, then executed against
                your Postgres — or returned as a clean deny the agent can
                recover from.
              </p>
            </div>
          </div>
          <div className="mech">
            <div className="step">
              <div className="n">Setup · once</div>
              <h3>One URL replaces the connection string.</h3>
              <p>
                Drop a Midplane MCP URL into Cursor, Claude Code or Claude
                Desktop. The agent never sees your DSN, password, or network.
              </p>
              <div className="ascii">
                {"cursor / claude / codex\n   │\n   ▼\n"}
                <b>{"https://eu.midplane.ai\n   /mcp/tok_3f12…"}</b>
              </div>
            </div>
            <div className="step">
              <div className="n">Per query · 01</div>
              <h3>Policy decides every query.</h3>
              <p>
                Read-only by default. Writes only on opted-in tables. Tenant
                predicate required. Multi-statement and DDL — even hidden inside
                a CTE — are always denied.
              </p>
              <div className="ascii">
                {"table_access · "}
                <span className="a">ALLOW</span>
                {"\ntenant_scope · "}
                <span className="a">ALLOW</span>
                {"\nmulti_stmt   · "}
                <span className="d">DENY</span>
                {"\nddl          · "}
                <span className="d">DENY</span>
              </div>
            </div>
            <div className="step">
              <div className="n">Per query · 02</div>
              <h3>Logged before it runs.</h3>
              <p>
                Every attempt — allowed or denied — is written before the query
                touches Postgres. If logging fails, the query is rejected.
              </p>
              <div className="ascii">
                {"audit_log ←\n  who   = lena@acme\n  agent = claude-code\n  table = users\n  stage = ATTEMPTED\n  "}
                <b>committed</b>
              </div>
            </div>
            <div className="step">
              <div className="n">Per query · 03</div>
              <h3>…or return a clean deny.</h3>
              <p>
                Allowed queries hit Postgres normally. Denied queries return a
                structured error the agent can read and pivot from — no surprise
                crashes, no half-written rows.
              </p>
              <div className="ascii">
                {"EXECUTED\n└ "}
                <span className="a">25 rows</span>
                {" · 4.1 ms\n\nDENIED\n└ "}
                <span className="d">reason: table_access</span>
                {"\n└ users.email · write\n└ not in opt-in list"}
              </div>
            </div>
          </div>
        </section>

        {/* §02 — Policy: an abstract mockup of the actual shipped editor. */}
        {/*    Matches PermissionGrid (default access pill row + per-table
              overrides) and TenantScopeEditor (off/on toggle + default
              column input + per-table override/exempt rows). Vocabulary
              from @midplane-cloud/db/policy: deny / read / read_write. */}
        <section className="sec" id="policy">
          <div className="sec-top">
            <div className="sec-num">
              <b>03</b>Policy
            </div>
            <div>
              <h2 className="sec-h">
                A policy editor <em>you can read at a glance.</em>
              </h2>
              <p className="sec-sub">
                Default access in one click. Per-table overrides for the few
                that need write. Tenant scope on or off, with a column you
                control. Saved policy reaches the engine in milliseconds — no
                agent restart, no DSN reshuffle.
              </p>
            </div>
          </div>
          <div className="split-pair">
            <div className="copy">
              <span className="copy-eyebrow">policy</span>
              <h2>
                Opt in <span style={{ color: "var(--accent-blue)" }}>per table.</span>
              </h2>
              <p>
                Schema-qualified entries (<span className="mono">stripe.charges</span>)
                win over bare names. Saves push to the engine over the admin
                channel; the agent&apos;s active MCP session keeps running.
              </p>
            </div>
            <div className="policy-ui">
              <div className="pui-head">
                <span className="pui-title">acme · production</span>
                <span className="pui-tag">saved</span>
              </div>

              <div className="pui-section">
                <div className="pui-sec-title">Default for unlisted tables</div>
                <div className="pui-pills">
                  <span className="pill deny">
                    <span className="dot" aria-hidden /> deny
                  </span>
                  <span className="pill read on">
                    <span className="dot" aria-hidden /> read
                  </span>
                  <span className="pill rw">
                    <span className="dot" aria-hidden /> read + write
                  </span>
                </div>
              </div>

              <div className="pui-section">
                <div className="pui-sec-title">Per-table overrides</div>
                <div className="pui-row">
                  <span className="pui-key">feature_flags</span>
                  <span className="pui-row-end">
                    <span className="pui-val pui-val-rw">read + write</span>
                    <button
                      type="button"
                      className="pui-x"
                      aria-label="Remove"
                      tabIndex={-1}
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div className="pui-row">
                  <span className="pui-key">audit_log</span>
                  <span className="pui-row-end">
                    <span className="pui-val pui-val-deny">deny</span>
                    <button
                      type="button"
                      className="pui-x"
                      aria-label="Remove"
                      tabIndex={-1}
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div className="pui-row">
                  <span className="pui-key">stripe.charges</span>
                  <span className="pui-row-end">
                    <span className="pui-val pui-val-deny">deny</span>
                    <button
                      type="button"
                      className="pui-x"
                      aria-label="Remove"
                      tabIndex={-1}
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div className="pui-row pui-add">
                  <span className="pui-key">+ add table</span>
                  <span aria-hidden />
                </div>
              </div>

              <div className="pui-section">
                <div className="pui-sec-title">Tenant scope</div>
                <div className="pui-row">
                  <span className="pui-key">Enforce on every query</span>
                  <span className="pui-toggle">on</span>
                </div>
                <div className="pui-row">
                  <span className="pui-key">Default column</span>
                  <span className="pui-val">tenant_id</span>
                </div>
              </div>

              <div className="pui-foot">
                <span>Changes take effect immediately — no agent restart.</span>
                <span className="pui-actions">
                  <button type="button" className="pui-save" tabIndex={-1}>
                    Save permissions
                  </button>
                </span>
              </div>
            </div>

            {/* Engine invariants live OUTSIDE the editor — they're hardcoded
                in the parser, not configurable rows. */}
            <p className="pui-note">
              <span className="pui-note-label">Engine invariants</span>
              Multi-statement queries and DDL are always denied at the parser —
              not configurable, not in the editor.
            </p>
          </div>
        </section>

        {/* §04 — Audit (was §05; vs-roles dropped) */}
        <section className="sec" id="audit">
          <div className="sec-top">
            <div className="sec-num">
              <b>04</b>Audit
            </div>
            <div>
              <h2 className="sec-h">
                Every query. Every decision. <em>Filterable.</em>
              </h2>
              <p className="sec-sub">
                Append-only. Filterable by agent, table, tenant, decision.
                Every row records the MCP client and the agent&apos;s declared
                intent — and for changes you make in the dashboard, the
                engineer who made them. So six months later you can ask
                &ldquo;what was <span className="mono">claude-code</span>{" "}
                trying to do?&rdquo; or &ldquo;who flipped that flag?&rdquo;
              </p>
            </div>
          </div>
          <div className="audit-card">
            <div className="head">
              <h4>audit_log · last 6 events</h4>
              <span className="meta">2 denied · region eu · acme/production</span>
            </div>
            <div className="at-table">
              <div className="hd">
                <span>time</span>
                <span>decision</span>
                <span>statement</span>
                <span>agent</span>
                <span>ms</span>
              </div>
              <div className="tr">
                <span className="ts">14:02:11.034</span>
                <span className="dec-allow">ALLOW</span>
                <span className="sql">
                  SELECT id, email FROM users WHERE tenant_id = $1
                </span>
                <span>cursor · v0.45</span>
                <span className="dur">4.1</span>
              </div>
              <div className="tr deny">
                <span className="ts">14:02:13.221</span>
                <span className="dec-deny">DENY</span>
                <span className="sql">
                  WITH d AS (DELETE FROM users RETURNING *) SELECT…
                </span>
                <span>cursor · v0.45</span>
                <span className="dur">1.6</span>
              </div>
              <div className="tr">
                <span className="ts">14:02:14.802</span>
                <span className="dec-allow">ALLOW</span>
                <span className="sql">
                  SELECT count(*) FROM users WHERE tenant_id = $1
                </span>
                <span>cursor · v0.45</span>
                <span className="dur">2.3</span>
              </div>
              <div className="tr">
                <span className="ts">14:02:18.555</span>
                <span className="dec-allow">ALLOW</span>
                <span className="sql">
                  UPDATE feature_flags SET enabled = true WHERE …
                </span>
                <span>claude-code · 1.2</span>
                <span className="dur">3.0</span>
              </div>
              <div className="tr deny">
                <span className="ts">14:02:22.013</span>
                <span className="dec-deny">DENY</span>
                <span className="sql">
                  SELECT * FROM users — missing tenant_id
                </span>
                <span>claude-code · 1.2</span>
                <span className="dur">0.8</span>
              </div>
              <div className="tr">
                <span className="ts">14:02:25.144</span>
                <span className="dec-allow">ALLOW</span>
                <span className="sql">
                  EXPLAIN ANALYZE SELECT * FROM jobs WHERE tenant…
                </span>
                <span>claude-desktop · 0.8</span>
                <span className="dur">6.7</span>
              </div>
            </div>
          </div>
        </section>

        {/* §05 — Isolation */}
        <section className="sec">
          <div className="sec-top">
            <div className="sec-num">
              <b>05</b>Isolation
            </div>
            <div>
              <h2 className="sec-h">
                What we store. <em>What we don&apos;t.</em>
              </h2>
              <p className="sec-sub">
                Midplane brokers the query and writes an audit row. The query
                results forward straight to the agent — we don&apos;t inspect
                them, we don&apos;t persist them. The little we do hold —
                connection credentials, policy, audit log — is encrypted per
                workspace and pinned to the region you pick at signup.
              </p>
            </div>
          </div>
          <div className="iso">
            <div className="iso-copy">
              <h3>What lives where.</h3>
              <p>The data plane is your Postgres. We&apos;re a control plane in front of it.</p>
              <ul>
                <li>
                  <span>
                    <b>Query results pass through, unstored.</b> We see the SQL
                    and the decision (allow / deny), we forward the rows. The
                    rows themselves don&apos;t sit in our system.
                  </span>
                </li>
                <li>
                  <span>
                    <b>Per-workspace encryption.</b> Connection credentials,
                    policy, and audit log are envelope-encrypted with a KMS
                    key bound to your workspace. We can&apos;t decrypt another
                    workspace&apos;s data with yours.
                  </span>
                </li>
                <li>
                  <span>
                    <b>Region-pinned.</b> Pick <span className="mono">eu</span>{" "}
                    or <span className="mono">us</span> at signup; the control
                    plane stays there.
                  </span>
                </li>
              </ul>
            </div>
            <div className="iso-diagram">
              <div className="lane">
                <div className="lbl">
                  CLIENT
                  <b>Cursor / Claude Code</b>
                </div>
                <div className="box">
                  <span>agent</span>
                  <span className="tag">MCP</span>
                </div>
              </div>
              <div className="arrow">
                <span>https · token-auth</span>
              </div>
              <div className="lane">
                <div className="lbl">
                  MIDPLANE
                  <b>eu or us · your pick</b>
                </div>
                <div className="box midplane">
                  <span>
                    <b>policy</b> + <b>audit log</b>
                  </span>
                  <span className="tag">KMS · workspace-bound</span>
                </div>
              </div>
              <div className="arrow">
                <span>tls · your DSN</span>
              </div>
              <div className="lane">
                <div className="lbl">
                  YOUR INFRA
                  <b>your VPC · your Postgres</b>
                </div>
                <div className="box your">
                  <span>
                    <b>your data</b> · query results forward through us
                  </span>
                  <span className="tag">unstored</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* §06 — Hosted / self-host */}
        <section className="sec" id="hosted">
          <div className="sec-top">
            <div className="sec-num">
              <b>06</b>Hosted
            </div>
            <div>
              <h2 className="sec-h">
                Same engine. <em>Two ways to run it.</em>
              </h2>
              <p className="sec-sub">
                Midplane is MIT-licensed open source. Run it on our hosted
                cloud or run the container yourself. The policy engine, audit
                format, and configuration files are identical either way — you
                can start hosted and move to self-host (or the reverse) without
                rewriting anything.
              </p>
            </div>
          </div>
          <div className="parity">
            <div>
              <div className="tag">
                <span className="d" aria-hidden />
                <span>Hosted · EU + US</span>
              </div>
              <h3>We host it.</h3>
              <p>
                Sign up, paste your DSNs, drop the MCP URL into your agent.
                You get back hours of platform work.
              </p>
              <ul className="cloud-list">
                <li>
                  <span className="mk">✓</span>
                  <span>
                    <b>Isolation managed</b> — region pinning, per-workspace KMS,
                    scoped connection pools.
                  </span>
                </li>
                <li>
                  <span className="mk">✓</span>
                  <span>
                    <b>Audit storage included</b> — 7 / 30 / 180-day retention
                    by tier. Append-only, queryable from the dashboard.
                  </span>
                </li>
                <li>
                  <span className="mk">✓</span>
                  <span>
                    <b>Free forever</b> — 1 connection, 1 seat, 7-day audit
                    retention. No credit card. Query volume is not metered.
                  </span>
                </li>
              </ul>
              <span className="image-tag mono">
                fly · <b>eu + us</b>
              </span>
              <div className="footnote">
                <span>setup &lt; 60s</span>
                <span>v0.5.0</span>
              </div>
            </div>
            <div>
              <div className="tag">
                <span className="d" aria-hidden />
                <span>Self-host · MIT</span>
              </div>
              <h3>You host it.</h3>
              <p>
                Run the same container in your own infrastructure. Common
                reasons: on-prem requirement, air-gapped network, existing
                Postgres platform you want to extend.
              </p>
              <ul className="host-list">
                <li>
                  <span className="mk">○</span>
                  <span>
                    You handle patching, upgrades, audit storage, HA, and
                    region routing.
                  </span>
                </li>
                <li>
                  <span className="mk">○</span>
                  <span>
                    Open source, MIT licensed. Same engine, same policy
                    format, same audit shape as the hosted plane.
                  </span>
                </li>
              </ul>
              <span className="image-tag mono">
                github · <b>midplaneai/midplane</b>
              </span>
              <div className="footnote">
                <span>docker pull midplane/midplane:0.6.0</span>
                <span>install &lt; 30s</span>
              </div>
            </div>
          </div>
        </section>

        {/* §08 — Pricing */}
        <section className="sec" id="pricing">
          <div className="sec-top">
            <div className="sec-num">
              <b>07</b>Pricing
            </div>
            <div>
              <h2 className="sec-h">
                Pay for scale, <em>not the safety engine.</em>
              </h2>
              <p className="sec-sub">
                Policy enforcement, audit log, and tenant isolation are on
                every tier. Tiers gate structural growth — more connections,
                more seats, longer retention, enterprise SSO. Query volume is
                never metered.
              </p>
            </div>
          </div>
          <div className="pricing">
            <div className="tier free">
              <div className="tier-head">
                <span className="tier-name">Free</span>
                <span className="tier-price">
                  $0 <small>/ month</small>
                </span>
                <span className="tier-sub">For one engineer evaluating.</span>
              </div>
              <ul className="tier-rows">
                <li>
                  <span>Connections</span>
                  <b>1</b>
                </li>
                <li>
                  <span>MCP tokens</span>
                  <b>1</b>
                </li>
                <li>
                  <span>Seats</span>
                  <b>1</b>
                </li>
                <li>
                  <span>Audit retention</span>
                  <b>7 days</b>
                </li>
                <li>
                  <span>SSO / SAML</span>
                  <b className="muted">—</b>
                </li>
                <li>
                  <span>Support</span>
                  <b>Community</b>
                </li>
              </ul>
              <Link className="ebtn outline tier-cta" href="/sign-up">
                Start free →
              </Link>
            </div>
            <div className="tier pro">
              <div className="tier-head">
                <span className="tier-name">Pro</span>
                <span className="tier-price">
                  $49 <small>/ month</small>
                </span>
                <span className="tier-sub">
                  For a small team putting agents into production.
                </span>
              </div>
              <ul className="tier-rows">
                <li>
                  <span>Connections</span>
                  <b>10</b>
                </li>
                <li>
                  <span>MCP tokens</span>
                  <b>10</b>
                </li>
                <li>
                  <span>Seats</span>
                  <b>10</b>
                </li>
                <li>
                  <span>Audit retention</span>
                  <b>30 days</b>
                </li>
                <li>
                  <span>SSO / SAML</span>
                  <b className="muted">—</b>
                </li>
                <li>
                  <span>Support</span>
                  <b>Email</b>
                </li>
              </ul>
              <Link className="ebtn fill tier-cta" href="/sign-up">
                Start Pro →
              </Link>
            </div>
            <div className="tier team">
              <div className="tier-head">
                <span className="tier-name">Team</span>
                <span className="tier-price">
                  $399 <small>/ month</small>
                </span>
                <span className="tier-sub">
                  When security or compliance asks.
                </span>
              </div>
              <ul className="tier-rows">
                <li>
                  <span>Connections</span>
                  <b>Unlimited</b>
                </li>
                <li>
                  <span>MCP tokens</span>
                  <b>Unlimited</b>
                </li>
                <li>
                  <span>Seats</span>
                  <b>Unlimited</b>
                </li>
                <li>
                  <span>Audit retention</span>
                  <b>180 days</b>
                </li>
                <li>
                  <span>SSO / SAML</span>
                  <b className="allow">✓</b>
                </li>
                <li>
                  <span>Support</span>
                  <b>Priority email</b>
                </li>
              </ul>
              <Link className="ebtn outline tier-cta" href="/sign-up">
                Start Team →
              </Link>
            </div>
          </div>
          <p className="pricing-custom">
            <b>Custom needs?</b> BYOK, dedicated region, SOC2 / HIPAA
            artifacts, SAML below Team, custom retention, SLA —{" "}
            <a href="mailto:sales@midplane.ai">talk to us</a>.
          </p>
        </section>

        {/* §09 — Quickstart */}
        <section className="sec" id="quickstart">
          <div className="sec-top">
            <div className="sec-num">
              <b>08</b>Quickstart
            </div>
            <div>
              <h2 className="sec-h">
                From signup to first allowed query: <em>under a minute.</em>
              </h2>
              <p className="sec-sub">
                Four steps, one MCP URL, the client you already use. Cursor,
                Claude Code and Claude Desktop are verified — every other MCP
                client we&apos;ve tested works too.
              </p>
            </div>
          </div>

          <div className="timeline">
            <div className="t-step">
              <span className="t-time">00:00</span>
              <span className="t-act">Sign up</span>
            </div>
            <div className="t-step">
              <span className="t-time">00:20</span>
              <span className="t-act">Paste your DSN</span>
            </div>
            <div className="t-step">
              <span className="t-time">00:40</span>
              <span className="t-act">Drop the MCP URL into your client</span>
            </div>
            <div className="t-step done">
              <span className="t-time">01:00</span>
              <span className="t-act">First query, logged</span>
            </div>
          </div>

          <div className="clients">
            <div className="client">
              <div className="name">
                <h4>Cursor</h4>
                <span className="v">verified</span>
              </div>
              <pre>
                <span className="com"># ~/.cursor/mcp.json</span>
                {"\n{\n  "}
                <b>&quot;mcpServers&quot;</b>
                {": {\n    "}
                <b>&quot;midplane&quot;</b>
                {": {\n      "}
                <b>&quot;url&quot;</b>
                {': "https://eu.midplane.ai/mcp/<tok>"\n    }\n  }\n}'}
              </pre>
            </div>
            <div className="client">
              <div className="name">
                <h4>Claude Code</h4>
                <span className="v">verified</span>
              </div>
              <pre>
                <span className="com"># one line, terminal</span>
                {"\nclaude mcp add \\\n  --transport http \\\n  midplane \\\n  https://eu.midplane.ai/mcp/<tok>"}
              </pre>
            </div>
            <div className="client">
              <div className="name">
                <h4>Claude Desktop</h4>
                <span className="v">verified</span>
              </div>
              <pre>
                <span className="com"># Settings → Connectors → Add</span>
                {"\nname: midplane\nurl:  https://eu.midplane.ai/mcp/<tok>\n\n"}
                <span className="com"># or claude_desktop_config.json</span>
              </pre>
            </div>
          </div>
        </section>

        {/* close band — final CTA. Hero already framed the value and the
            pricing section above already showed tiers, so the band reduces
            to the headline + buttons. */}
        <section className="close">
          <div className="inner">
            <h2>
              Let Claude query <em>your real database.</em>
            </h2>
            <div className="ctas">
              <Link className="ebtn fill" href="/sign-up">
                Start free →
              </Link>
              <a className="ebtn outline" href="#how">
                Read the docs
              </a>
            </div>
          </div>
        </section>

        <footer className="efoot">
          <div>
            <div className="brand">
              <span className="mark" aria-hidden />
              <span>midplane</span>
            </div>
            <p className="cop">
              A safety layer between AI coding agents and your Postgres
              database. MIT-licensed engine, hosted in EU + US.
            </p>
          </div>
          <div>
            <h5>Product</h5>
            <a href="#hosted">Hosted</a>
            <a href="#hosted">Self-host</a>
            <a href="#audit">Audit</a>
            <a href="#policy">Policy</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div>
            <h5>Docs</h5>
            <a href="#quickstart">Quickstart</a>
            <a href="#policy">Policy reference</a>
            <a href="#quickstart">MCP clients</a>
            <a href="https://github.com/midplaneai/midplane">Changelog</a>
          </div>
          <div>
            <h5>Open</h5>
            <a href="https://github.com/midplaneai/midplane">
              github.com/midplaneai/midplane
            </a>
            <a href="#">Status</a>
            <a href="#">Security</a>
            <a href="#">Contact</a>
          </div>
        </footer>
      </div>
    </main>
  );
}
