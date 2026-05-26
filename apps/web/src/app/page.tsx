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

import { CyclingAgent } from "./_landing/cycling-agent";
import { HostedTabs } from "./_landing/hosted-tabs";
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
          <Link href="/" aria-label="midplane" className="brand mp-wordmark">
            mid<span className="mp-colon">:</span>plane
          </Link>
          <nav className="nav">
            <a href="#how">Product</a>
            <a href="#policy">Policy</a>
            <a href="#audit">Audit</a>
            <a href="#hosted">Hosted</a>
            <a href="#pricing">Pricing</a>
          </nav>
          <div className="topright">
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
            <a
              className="yc-badge"
              href="https://www.ycombinator.com/companies/midplane"
              target="_blank"
              rel="noopener noreferrer"
            >
              <span className="yc-mark" aria-hidden>
                Y
              </span>
              <span>Backed by Y Combinator</span>
            </a>
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
            <div className="sec-num">—&nbsp;try</div>
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
              <b>01</b>
              <span className="c">:</span>stakes
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
                <span>before<span className="c">:</span>midplane</span>
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
                <span>after<span className="c">:</span>midplane</span>
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

        {/* §02 — How it works. Was four stacked step cards (setup + three
            per-query beats), each restating a slice of the same story.
            Collapsed into a single flow diagram: a small one-time setup
            band above, then the three per-query checkpoints inside one
            bordered midplane block. */}
        <section className="sec" id="how">
          <div className="sec-top">
            <div className="sec-num">
              <b>02</b>
              <span className="c">:</span>flow
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
          <div className="flow">
            <div className="flow-setup">
              <span className="flow-setup-label mono">Setup · once</span>
              <span className="flow-setup-desc">
                Drop a Midplane MCP URL into your agent. The agent never sees
                your DSN, password, or network.
              </span>
              <span className="flow-setup-token mono">
                cursor / claude{" "}
                <span className="flow-setup-arrow" aria-hidden>
                  →
                </span>{" "}
                <b>https://eu.midplane.ai/mcp/&lt;tok&gt;</b>
              </span>
            </div>
            <div className="flow-runtime">
              <div className="flow-runtime-tag mono">
                Midplane · every query
              </div>
              <div className="flow-checkpoints">
                <article className="flow-check">
                  <span className="flow-check-num mono">
                    <b>01</b>
                    <span className="c">:</span>policy
                  </span>
                  <h3 className="flow-check-title">Decided.</h3>
                  <pre className="flow-check-body">
                    {"table_access · "}
                    <span className="a">allow</span>
                    {"\ntenant_scope · "}
                    <span className="a">allow</span>
                    {"\nmulti_stmt   · "}
                    <span className="d">deny</span>
                    {"\nddl          · "}
                    <span className="d">deny</span>
                  </pre>
                  <p className="flow-check-caption">
                    Read-only default, writes per opt-in table, tenant
                    predicate required.
                  </p>
                </article>
                <article className="flow-check">
                  <span className="flow-check-num mono">
                    <b>02</b>
                    <span className="c">:</span>audit
                  </span>
                  <h3 className="flow-check-title">Logged.</h3>
                  <pre className="flow-check-body">
                    {"audit_log ←\n  who   = lena@acme\n  agent = claude-code\n  table = users\n  stage = ATTEMPTED\n  "}
                    <b>committed</b>
                  </pre>
                  <p className="flow-check-caption">
                    Written before Postgres sees the query. Log failure rejects
                    the query.
                  </p>
                </article>
                <article className="flow-check">
                  <span className="flow-check-num mono">
                    <b>03</b>
                    <span className="c">:</span>execute
                  </span>
                  <h3 className="flow-check-title">…or denied.</h3>
                  <pre className="flow-check-body">
                    <span className="a">allow</span>
                    {" → postgres\n     └ 25 rows · 4.1 ms\n\n"}
                    <span className="d">deny</span>
                    {" → structured reply\n     └ reason: table_access\n     └ agent pivots"}
                  </pre>
                  <p className="flow-check-caption">
                    Allowed queries run normally. Denied queries return a
                    parsable error — no half-writes.
                  </p>
                </article>
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
              <b>03</b>
              <span className="c">:</span>policy
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
              <h2>
                Opt in <span style={{ color: "var(--accent-blue)" }}>per table.</span>
              </h2>
              <p>
                Schema-qualified entries (<span className="mono">stripe.charges</span>)
                win over bare names. Saves push to the engine over the admin
                channel; the agent&apos;s active MCP session keeps running.
              </p>
              {/* Engine invariants — hardcoded at the parser, not editor
                  rows. Lifted from a footnote into a proper callout so the
                  always-denied dimension reads as a feature, not a caveat. */}
              <div className="invariants">
                <div className="invariants-label mono">Engine invariants</div>
                <ul className="invariants-list">
                  <li>
                    <span className="invariants-tag mono">always deny</span>
                    <span>
                      <b>Multi-statement queries</b> — even a{" "}
                      <span className="mono">DELETE</span> hidden inside a CTE.
                    </span>
                  </li>
                  <li>
                    <span className="invariants-tag mono">always deny</span>
                    <span>
                      <b>DDL</b> — <span className="mono">DROP</span>,{" "}
                      <span className="mono">ALTER</span>,{" "}
                      <span className="mono">CREATE</span> never reach Postgres.
                    </span>
                  </li>
                </ul>
                <p className="invariants-foot">
                  Enforced at the parser. Not configurable, not in the editor.
                </p>
              </div>
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
          </div>
        </section>

        {/* §04 — Audit (was §05; vs-roles dropped) */}
        <section className="sec" id="audit">
          <div className="sec-top">
            <div className="sec-num">
              <b>04</b>
              <span className="c">:</span>audit
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
              <b>05</b>
              <span className="c">:</span>isolation
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
              <p>
                The data plane is your Postgres. We&apos;re a control plane in
                front of it — query results pass through unstored, the little
                we do hold is envelope-encrypted per workspace, and the whole
                control plane is pinned to the region you pick at signup.
              </p>
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
              <b>06</b>
              <span className="c">:</span>hosted
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
          <HostedTabs />
        </section>

        {/* §08 — Pricing */}
        <section className="sec" id="pricing">
          <div className="sec-top">
            <div className="sec-num">
              <b>07</b>
              <span className="c">:</span>pricing
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
            <a href="mailto:info@midplane.ai">talk to us</a>.
          </p>
        </section>

        {/* §08 — Quickstart. The per-client config tabs that used to live
            here showed mostly equivalent code (JSON for Cursor, CLI for
            Claude Code, UI path for Claude Desktop) and read as boilerplate.
            Replaced with a one-line client list; the satisfying single
            command moved to the close band below. */}
        <section className="sec" id="quickstart">
          <div className="sec-top">
            <div className="sec-num">
              <b>08</b>
              <span className="c">:</span>start
            </div>
            <div>
              <h2 className="sec-h">
                From signup to first allowed query: <em>under a minute.</em>
              </h2>
              <p className="sec-sub">
                Four steps, one MCP URL, the client you already use.
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

          <p className="qs-clients">
            Verified with <b>Cursor</b>, <b>Claude Code</b>, and{" "}
            <b>Claude Desktop</b>. Works with any MCP-capable client.
          </p>
        </section>

        {/* close band — final CTA. Hero already framed the value and the
            pricing section above already showed tiers, so the band reduces
            to the headline + buttons. */}
        <section className="close">
          <div className="inner">
            <h2>
              Let <CyclingAgent /> query <em>your real database.</em>
            </h2>
            <div className="ctas">
              <Link className="ebtn fill" href="/sign-up">
                Start free →
              </Link>
            </div>
          </div>
        </section>

        <footer className="efoot">
          <div>
            <span
              className="brand mp-wordmark mp-on-dark"
              aria-label="midplane"
            >
              mid<span className="mp-colon">:</span>plane
            </span>
            <p className="cop">
              A safety layer between AI coding agents and your Postgres
              database. MIT-licensed engine, hosted in EU + US.
            </p>
          </div>
          <div>
            <h5>Product</h5>
            <a href="#hosted">Hosted</a>
            <a href="#audit">Audit</a>
            <a href="#policy">Policy</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div>
            <h5>Open</h5>
            <a href="https://github.com/midplaneai/midplane">
              github.com/midplaneai/midplane
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}
