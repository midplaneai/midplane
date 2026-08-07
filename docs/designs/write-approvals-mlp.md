# Design: write approvals (MLP)

**Status:** built except the engine publish (step 9). Engine 1020 tests, control plane 1250, all green.
**Branch:** `lange-labs/write-approvals`
**Supersedes for v1:** the two-rung plan in
`~/.gstack/projects/midplaneai-midplane/dustinlange-lange-labs-write-approval-queue-design-20260803-000000.md`
**Prior art:** `lange-labs/write-approval-queue` — a complete, green implementation
(1,144 engine tests, 55 control-plane approval tests, ~18k lines). This document
deliberately builds a smaller thing and explains, per subsystem, what it takes from
that branch and what it leaves.

---

## The one-sentence product

A write the policy already permits is held until a human approves it, and the human is
not the agent's client — so "always allow" cannot dismiss it, machine tokens are covered,
and the decision is recorded org-side.

---

## Why this is smaller than the branch it learns from

The `write-approval-queue` design led with **blast radius**: estimate affected rows via
`EXPLAIN`, and route by band — under `allow_max` run, over `block_min` deny, between them
hold. The queue existed to keep that guardrail from being an obstacle.

That branch then measured the estimator against real Postgres and wrote the result into
its own changelog:

> 0.005%–0.4% error on simple predicates with fresh statistics, but **3x under** on
> correlated predicates, **~5x under** on `WHERE id IN (subquery)`, and — with statistics
> stale after a bulk load — **1 row estimated against 400,000 actual**. Every failure mode
> errs LOW, which is the unsafe direction.

Everything expensive on that branch descends from that sentence. The post-execution
`rowCount` guard (execute in a transaction, compare the real count to a ceiling, roll back
over it) exists because the estimate cannot be trusted. Stale-statistics escalation exists
because `n_mod_since_analyze` predicts when it will be *most* wrong. Strictest-band-wins
across write sites, the `writeSites` collector, `MERGE` handling, per-table bands, the
`REVIEW` audit decision and the `RESOLVED` event — all of it is scaffolding around a number
that errs low.

**The MLP deletes the number.** A gate that holds *every* write has nothing to estimate and
therefore nothing to be wrong about. That is not merely less work; it removes the feature's
largest correctness liability, and with it the need for every mitigation above.

What we give up is real and should be stated plainly: without an estimate, the approver
sees the statement but not its magnitude, and every write pages someone. The premise the
prior design used to reject exactly this shape was:

> An approval queue without a blast-radius signal has no sensible trigger: "all writes" is
> too noisy to keep enabled.

**The rebuttal is that the noise floor is already set by an existing control.** Only tables
a user has deliberately marked `write` in `table_access` can produce a held write at all.
"All writes" means "all writes to the handful of tables you already decided an agent may
write to" — not "all statements." A project with one writable table generates approvals at
the rate that table is written. If that is still too noisy in practice, the escape hatch is
the estimate, and it is a rung we add later on top of a loop that already works.

---

## Scope

### In

| | |
|---|---|
| Trigger | One boolean per database: writes require approval. No thresholds, no per-table rules. |
| Gate | Engine holds the request, asks the control plane, executes or refuses on the answer. |
| Hold | Bounded (~20s) with no progress notifications; past it the agent gets a resumable ticket. |
| Resume | Agent re-runs the identical statement. No new MCP tool, no `approval_id` argument. |
| Approvers | Org owner/admin. Self-approval **allowed**. One approval settles it. |
| Queue | `/approvals` — pending list, statement, context, approve/deny. |
| Notify | Link-only email to approvers. |
| Expiry | Configurable window, expires to a denial. |
| Audit | No new event types or decision values (see "Audit", below). |

### Out

Blast-radius estimates and everything downstream of them; per-table approval rules;
approver chains; N-of-M; a named reviewer set; MCP progress notifications; Slack;
mandatory justification; dry-run diffs; approvals on reads; plan gating.

---

## Architecture

Engine holds, control plane decides. This follows the prior branch's Approach B, and the
reasoning survives the estimator's removal: the engine already speaks MCP inside the tool
handler, it has already parsed the statement once, and self-host inherits the gate for free.
The rejected alternative (proxy parses JSON-RPC and holds) would hand-roll SSE framing in
`apps/web/src/lib/proxy.ts` and re-derive write detection cloud-side.

```
agent → proxy → engine.handle()
                  parse → evaluate() [sync, ALLOW|DENY as today]
                        → ALLOW and approvals.writes and program has a write site?
                             ├─ no  → execute (byte-for-byte today's path)
                             └─ yes → ApprovalGate.request(...)  ──HTTP──►  control plane
                                        ├─ APPROVE → execute
                                        ├─ DENY    → refuse
                                        ├─ PENDING → ticket, agent re-runs to collect
                                        └─ unreachable → ApprovalUnavailableError (retryable)
```

### Write detection is free

The prior branch built a `writeSites` collector because `EXPLAIN` needed per-table identity,
and because a naive walker reports `SELECT` for `WITH d AS (DELETE FROM orders) SELECT
count(*) FROM d` — a day-one bypass.

A boolean gate needs neither. `NormalizedProgram.accessChecks` already carries
`{ kind: "write", ref }` for **every write-target node anywhere in the tree, including
inside CTEs** — that is what `table_access` replays to require `read_write`
(`engine/packages/engine/src/ir/types.ts:52-66`). So:

```ts
const isWrite = program.accessChecks.some((c) => c.kind === "write");
```

One line, CTE-safe by construction, and it cannot drift from the permission check because it
reads the same sequence. `MERGE` is already in the IR. `no_target` statements (`COPY`,
`CALL`, `DO`, …) always deny in `table_access` and never reach the gate.

**Verified against the real parser**, not inferred from the comment — `collectAccessChecks`
is byte-identical on `main` and on `write-approval-queue` (that branch only *added*
`collectWriteSites` beside it), so this result stands on `main`:

| statement | `auditStatementType` | has write check |
|---|---|---|
| `WITH d AS (DELETE FROM orders …) SELECT count(*) FROM d` | `SELECT` | **true** |
| `WITH u AS (UPDATE orders … RETURNING id) SELECT * FROM u` | `SELECT` | **true** |
| `MERGE INTO orders …` | `MERGE` | true |
| `INSERT INTO orders SELECT * FROM staging` | `INSERT` | true |
| `WITH c AS (SELECT * FROM orders) SELECT * FROM c` | `SELECT` | false |

The first two rows are the whole point: a gate keyed on `auditStatementType` would wave
both through.

### Where the stage goes

`Engine.handle()` after `evaluate()` returns ALLOW and after the `DECIDED` audit write, before
execute. `engine.ts:3` labels the pipeline "locked, T3" — inserting a stage is a deliberate
amendment and gets an ADR, same as the prior branch concluded.

Note the stage is async only because the *gate call* is; the decision to hold is synchronous
(a boolean and an array scan). This is why the MLP does not need `Executor.estimate()`, the
`explain.ts` dialect module, or transaction-scoped clients for a pre-flight round trip.

---

## Audit: no new vocabulary

The prior branch added a `REVIEW` decision and a `RESOLVED` event. That was the right call
for a three-band model where "held" is a distinct routing outcome — and it cost an engine
`schema.sql` change, the cloud `audit_events_index` mirror, a migration, new status
derivation, filter chips, CSV export columns, and a status badge. It also produced a bug
the branch shipped a TODO for: a held attempt that is approved and then executed by a
*retry* renders `HELD` in `/audit` forever, because the attempt that was held is not the
attempt that ran.

The MLP does not add any of it. `DecidedPayload` is a discriminated union on
`decision: "ALLOW" | "DENY"`, and `policy_rule` is a free-form `z.string()`
(`engine/packages/engine/src/audit/types.ts:61-70`). So:

- approved → `DECIDED(ALLOW)` → `EXECUTED`, exactly like any other allowed write
- denied → `DECIDED(DENY, policy_rule: "approval_denied")`
- expired → `DECIDED(DENY, policy_rule: "approval_expired")`

No `schema_version` concern, no cloud mirror migration, no new filter vocabulary, and the
superseded-attempt bug cannot occur because there is no `HELD` status to get stuck in.

The cost: "currently pending" is not an audit state. It lives in `write_approvals` and
renders at `/approvals`. That is the correct home — a live queue is not history.

---

## Data model

One new table, cloud-side only.

```
write_approvals
  id                    ULID, pk
  customer_id           fk
  project_id            fk
  project_database_id   fk
  region                'eu' | 'us'
  grant_key             text     -- deterministic; see Resume
  sql_text              text
  intent                text
  statement_type        text
  agent_name            text null
  mcp_token_id          text null
  requested_by_user_id  text null
  status                'pending' | 'approved' | 'denied' | 'expired'
  decided_by_user_id    text null
  decided_at            timestamptz null
  claimed_at            timestamptz null   -- single-use; see Resume
  expires_at            timestamptz
  created_at            timestamptz

  index (customer_id, region, status, created_at)
  unique (project_database_id, grant_key) where status = 'pending'
```

`sql_text` is region-resident and org-scoped. It never leaves in a notification — see
Notifications.

---

## Resume: the agent re-runs the statement

The prior branch shipped both an optional `approval_id` tool argument *and* a deterministic
fallback key. The MLP ships only the key, which removes a tool-schema change and the plumbing
to thread an id through an agent that may well drop it.

`grant_key = sha256(project_database_id ‖ normalized_sql ‖ intent ‖ mcp_token_id)`

On every gated write the engine computes the key and asks the control plane. The control
plane either finds an approved, unclaimed grant for that key (→ `APPROVE`, mark claimed) or
creates/finds a pending one (→ hold, then `PENDING`).

Two properties this buys, both carried directly from the prior branch because both are
load-bearing:

- **Statement-bound.** An approval granted for `DELETE … WHERE id < 100` cannot authorize
  `… < 100000` — different key, different grant. Verified by construction rather than by a
  comparison someone has to remember to write.
- **Single-use.** `claimed_at` is set in the same transaction that returns `APPROVE`. Two
  retries racing one approval yield one execution.

The agent-facing contract on a hold:

```
awaiting approval — a human must approve this write.
re-run this exact statement to collect the result. expires in 14m.
https://app.midplane.ai/approvals/apr_7Kq2vX
```

Re-running an *altered* statement correctly asks again. That is the rule, not a limitation.

---

## The hold, and why there are no progress notifications

MCP clients time out at ~60s (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` in the TypeScript SDK;
Claude Code and Cursor both inherit it for HTTP transports). The prior branch's answer was
`notifications/progress` on a ~20s cadence from inside the tool handler, and its own design
called that "the highest-risk item in the build" because the defense must be verified per
client.

The MLP sidesteps it: **hold for ~20s, well inside every client's timeout, then return the
ticket.** No progress notifications, nothing to verify per client, no long-lived connection
through the Fly proxy. A fast approval (someone watching the channel) completes in the first
call; a slow one completes on the agent's next attempt.

This is the single largest risk reduction in the MLP and it costs one round trip in the slow
case.

---

## Failure modes

Carried from the prior branch, which got these right and paid to learn them.

**An unreachable gate is not a denial.** If the control plane is down, the engine raises a
distinct `ApprovalUnavailableError` and writes **no** `DECIDED` row. A cloud outage must not
fire deny-webhooks, must not put a refusal nobody made into a compliance export, and must
reach the agent as a retryable error rather than a "no".

**Half-configured refuses to boot.** `MIDPLANE_APPROVAL_URL` and `MIDPLANE_APPROVAL_TOKEN`
are required together; the engine exits at startup rather than 401-ing every held write. Same
posture as the existing `MIDPLANE_DENY_WEBHOOK` pair.

**Approvals configured, no gate wired.** Fail closed: refuse the write with a message saying
approvals are enabled but no approver is reachable. Never silently run it.

**Notification failure never fails the hold.** Fire-and-forget, off the request path. A Resend
outage must not turn into held writes failing to be held; the queue is authoritative in-app
regardless.

---

## Notifications: link-only, by construction

The prior branch's `approval-notify.ts` established this and the reasoning is not
re-litigated here: every outbound payload carries ids, a database **alias**, an agent name,
and a URL. Never `sql_text`, never `tables_touched`.

Table and column names are customer schema, and a held `DELETE`'s `WHERE` clause routinely
carries live values — an email address, an account id. So the SQL is *data*, not metadata,
and email leaves the region into third-party retention. It renders in-app, where it is
org-scoped and region-resident.

This constraint is what makes Slack a separate decision rather than a delivery detail: an
approve-from-Slack button means approving without seeing the statement. Out of MLP scope,
noted so the constraint is not rediscovered.

---

## Config surface

One toggle, in the Database pane beside Table permissions and Guardrails.

```yaml
approvals:
  writes: true
  expires_after: 15m
```

Mirrors `guardrails` exactly — `ApprovalsConfig` type, `validateApprovals`, `DEFAULT_APPROVALS`
(off), emitted by the YAML serializer next to the `guardrails:` block
(`packages/db/src/policy.ts:200-292`, emit at `:376`). Being policy YAML rather than boot env
means it **hot-reloads via `pushPolicy`** and does not enter `bootFingerprint`, so toggling
approvals does not respawn a warm container and drop the agent's session.

`MIDPLANE_APPROVAL_URL` / `MIDPLANE_APPROVAL_TOKEN` are per-deployment constants injected at
spawn across all three backends (docker / fly / process), not per-project — the control plane
resolves project identity from the authenticated request.

### Approvers

Owner/admin, reusing `isManagerRole` (`apps/web/src/lib/org-roles.ts`). **Self-approval is
allowed**, which is a deliberate reversal of the mock's original rule and of the prior
design's target-user framing.

That design scoped the user as a 5–50 person team and excluded the solo developer — "their
client prompt is sufficient and an approval queue is pure friction." But its own Status Quo
section already contains the refutation:

> client-side approval already exists and is already defeated. It is approved by the same
> person driving the agent, it is granted once and permanently, it produces no org-level
> record, and it does not exist at all for machine tokens running headless.

A server-side gate gives a solo developer four things the client prompt cannot: it is
per-statement, it cannot be permanently dismissed, it is recorded, and it survives the agent
running unattended. The invariant worth defending is *the decision is explicit, per-statement,
and recorded* — not *someone else made it*. Four-eyes (requester ≠ approver) is a later org
toggle, not the default, and it is what deletes the approver-picker from the MLP UI.

---

## What we take, and what we leave

| Subsystem | From `write-approval-queue` | MLP |
|---|---|---|
| Gate architecture (engine holds) | Approach B, built | **Take.** Reasoning survives estimator removal. |
| `ApprovalUnavailableError` semantics | Built | **Take** verbatim. |
| Both-env-vars-or-refuse-boot | Built | **Take.** |
| Single-use, statement-bound grants | Built | **Take.** Key-only, drop the `approval_id` argument. |
| Link-only notification contract | Built + tested | **Take** verbatim. |
| `write_approvals` table | Built | **Take**, minus `row_estimate` / `band`. |
| `/approvals` page | Built as an audit lens | **Rebuild** against `write_approvals` directly. |
| Blast-radius estimator, bands, `explain.ts`, `Executor.estimate()` | Built | **Leave.** |
| Post-execution `rowCount` guard | Built | **Leave** — only needed because estimates err low. |
| Stale-statistics escalation | Built | **Leave.** |
| `writeSites` collector | Built | **Leave** — `accessChecks` already suffices. |
| `REVIEW` decision + `RESOLVED` event | Built | **Leave.** See Audit. |
| MCP progress notifications | Built | **Leave** — 20s hold is inside the client timeout. |
| Bands UI (`blast-radius-bands.tsx`, 296 lines) | Built | **Leave.** One toggle instead. |

Nothing here is a judgment that the left-hand column was wrong. It is correct work for a
larger product, and when blast radius returns it should be lifted from that branch rather
than rewritten.

---

## Build order

Each step is verifiable before the next begins.

1. **Policy shape** — `ApprovalsConfig`, validator, YAML emit, unit tests. No behavior yet.
2. **Engine gate** — `ApprovalGate` interface, the stage in `handle()`, fail-closed defaults,
   `ApprovalUnavailableError`. Tests with a stub gate; no network.
3. **Engine HTTP gate** — `MIDPLANE_APPROVAL_URL` / `_TOKEN`, boot validation. Mirrors
   `deny-webhook.ts`.
4. **Prove it locally** ✅ — `engine/packages/mcp-server/test/approval-e2e.live.test.ts`.
   Real policy YAML through the real loader, a real `HttpApprovalGate` over a real socket to
   a stub control plane, a real `PgPoolExecutor` against real Postgres. It asserts on the
   table rather than on a mock: approved changes the row; denied, pending, and gate-down all
   leave it untouched. Run with:
   ```
   APPROVALS_LIVE_PG_DSN=postgres://postgres@127.0.0.1:5432/postgres \
     bun test packages/mcp-server/test/approval-e2e.live.test.ts
   ```
   Mutation-checked — stubbing the approval stage to a no-op kills 5 of the 8 tests,
   including all three "nothing is written" guarantees.
5. **Cloud** — migration ✅, resolution logic ✅, `POST /api/engine/approvals` with the
   bounded hold, expiry sweep ✅.
   - `0005_slim_glorian.sql` — `write_approvals` + the `approvals` column. Verified by
     applying all six migrations to a fresh database.
   - `apps/web/src/lib/approvals.ts` — grant key, create-or-find, single-use claim,
     sweeper. Covered by `apps/web/test/approvals-live.test.ts` (15 tests) against real
     Postgres, because every property here is a concurrency or SQL-semantics claim that a
     mocked db would confirm regardless of truth:
     ```
     APPROVALS_LIVE_PG_DSN=postgres://postgres:pw@127.0.0.1:5433/mp_approvals \
       ./node_modules/.bin/vitest run apps/web/test/approvals-live.test.ts
     ```
     Mutation-checked: dropping `isNull(claimedAt)` from the claim kills the two
     single-use tests and nothing else.
   - `packages/router/src/approval-token.ts` — per-project HMAC bearer.
6. **Queue** ✅ — `/approvals` (cross-project), approve/deny actions, nav item.
   Members see it read-only; the decide controls and `decideAction` are owner/admin.
7. **Config UI** ✅ — `ApprovalsToggle` in the Database pane, below Guardrails
   (that order is the precedence). `setApprovals` + `approvalsAction`. Boot-env
   validation for `MIDPLANE_APPROVAL_SECRET` / `MIDPLANE_APP_ORIGIN` on both the
   cloud and self-host paths, plus `.env.example`.
8. **Notifications** ✅ — link-only email + the once-per-grant guard
   (`resolveApproval`'s `onCreated`, which fires only on a real insert).
9. **Ship the engine** — publish, bump `OSS_ENGINE_IMAGE`, re-resolve the digest for the two
   Fly configs, `scripts/check-image-pin.ts`. NOT DONE — this publishes a public image, so it
   needs a human to pull the trigger. Everything else is complete and green without it; the
   pin is still `0.15.0` and the drift check passes.

Step 4 before step 6 is the point of the ordering: the prior branch reached 1,199 green tests
with the loop still unproven end-to-end, because its cut engine version was never published
(`CHANGELOG` cuts 0.16.0; `OSS_ENGINE_IMAGE` pins 0.15.0; Docker Hub's newest tag is 0.15.0).
Green unit tests and a working demo are different claims.

---

## Traps found while building

Two that cost real time and would silently break the feature in production:

**`requires_features` is emitted once per database, and two emitters collide.**
`emitColumnMasks` wrote its own `requires_features:` key. A second section doing the same
produces a duplicate YAML key, and js-yaml's last-one-wins would silently drop one token —
turning a fail-closed engine into a permissive one. Feature tokens are now collected by
`collectRequiredFeatures` and emitted once.

**The hot-reload swap has TWO branches, and fixing one is not fixing it.** The factory
copies named fields on reload; approvals was not among them, so a toggle would land in the
control plane and never reach a warm engine — writes running unapproved until respawn. The
first fix patched only the legacy single-DB branch. The multi-DB branch, which is the shape
the cloud always emits, was still broken and the engine unit tests stayed green throughout.
Both are now patched and both are mutation-covered by
`engine/packages/mcp-server/test/approvals-reload.test.ts`, which asserts end-of-chain ("the
gate is now consulted") rather than on the holder.

## The resume contract, and where it is going

The agent is handed a ticket and re-runs the identical statement to collect. That is
**not** what most command-approval products do — hoop.dev blocks its CLI and executes
automatically on approval — but hoop controls its own client and its own timeout. We do
not: an MCP server is at the mercy of whatever client is connected, and those time out
around 60s.

Within the MCP ecosystem specifically, ticket-and-poll ("call now, fetch later") is the
convention for anything long-running, so this is the right lane for the transport rather
than an outlier.

**Target: the Tasks extension (SEP-2663, spec 2026-07-28).** A server answers `tools/call`
with a task handle (`resultType: "task"`) and the CLIENT drives `tasks/get` / `tasks/update`
/ `tasks/cancel`. That fixes the one real weakness here — today the *model* has to remember
to come back; under Tasks the *client* does it. `input_required` models "waiting on a human"
natively, and the statement stays in the engine's task rather than being fetched back from
the control plane, so the "engine only executes what the agent sent it" invariant survives.

Not adoptable yet: the reference TypeScript SDK does not implement the tasks suite (it is
the one conformance suite v2 does not pass, "aimed to ship with the stable release or soon
after"), and we are on 1.29.0. So clients cannot advertise it and we could not serve it
without hand-rolling the extension.

Watch for, in order: SDK v2 stable shipping tasks → clients advertising
`io.modelcontextprotocol/tasks` → `resultType: "task"` in client changelogs. Creation is
server-directed and gated on the client advertising support, so feature detection is built
into the protocol and today's ticket path becomes the fallback rather than dead code.

Meanwhile: do NOT invest further in the bespoke vocabulary. The mapping is already
one-to-one — `approval_id` → task id, `awaiting_approval` → `resultType: "task"`,
`check_approval` → `tasks/get`, `write_approvals` → the task store — so migration is mostly
a protocol envelope, not a redesign.

## Open decisions

1. **Expiry default.** Shipped at 30 minutes (`DEFAULT_APPROVALS`), bounded to 60s–24h.
   Still unvalidated against real behavior.
2. ~~**Does the hold re-notify on retry?**~~ Resolved: `resolveApproval` takes an
   `onCreated` hook that fires only when the insert actually happens, so a retrying agent
   opens one request and sends one email.
3. **Plan gating.** Prior design proposed Team tier. MLP has no gating; if approvals are the
   security-buyer feature, gating them out of Free may be right, but the solo-developer
   argument above cuts the other way. Undecided, and not a blocker.
4. **`/approvals` scope.** Cross-project (one queue for the workspace, matching the mock) vs.
   per-project. Cross-project is better for the approver and needs a region-aware query.
