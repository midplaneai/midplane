---
status: DRAFT
---
# Credentials & scope model: interactive vs headless agents

Branch: `lange-labs/mcp-oauth-launch` | Drafted 2026-06-17, after P6 (MCP OAuth at launch) shipped.

Captures the model the P6 OAuth work points toward, and sequences three related
follow-ups so they land as one coherent plan rather than three ad-hoc changes:
the consent-time scope picker, the connection→database flattening, and headless
(machine) credentials.

## What shipped (P6)

The `/mcp` proxy is now an OAuth 2.1 resource server (Better Auth `mcp` plugin).
An interactive agent (Claude Code, Cursor, Claude Desktop) points at a
per-connection URL `…/mcp/<connectionId>`; with no/invalid bearer it gets a 401 +
`WWW-Authenticate` discovery challenge and runs the OAuth flow natively (browser
sign-in → consent → token). The proxy maps the OAuth user → their customer,
checks they own the connection, mints one `kind='oauth'` attribution row per
(connection, OAuth client), and forwards — stamping the same per-agent
`mcp_token_id` the URL-token path stamps. The legacy `…/mcp/<token>` HMAC path is
preserved.

Two properties of this v1 are deliberately coarse, and motivate the model below:

1. **The token authorizes the *user*, not a connection.** The per-connection URL
   selects what the agent talks to, but the same bearer works on any connection
   the user owns (the proxy checks ownership, not a per-grant restriction).
2. **The connection id is no longer a secret.** Auth is the OAuth sign-in, so the
   URL is just an address — shown openly with a copy button, no show-once.

## The model

Two scenarios, two credential types, **one** everything-else:

| | who | credential | how access is bound |
|---|---|---|---|
| **Interactive** | Claude Code, Cursor, a person's agent | OAuth bearer (short-lived, refreshed) | **consent** picks the scope |
| **Headless** | CI, cron, code workflows, autonomous agents | a stored API-token secret | scope set **at token creation** |

The unifying claims — the whole point of the model:

- **Same wire shape.** Both are `Authorization: Bearer …`. The resolver
  distinguishes an OAuth-issued token from an API token by format. One endpoint
  shape serves both; a headless workflow sets one env var, no browser.
- **Same attribution.** Both produce a per-agent `mcp_token_id`, so the audit log
  reads identically regardless of credential type (already true today).
- **Same scope concept.** A least-privilege scope (which databases + read/write)
  rides on the credential. It is set two ways — **interactively via consent** for
  humans, **at creation in the dashboard** for headless tokens. *Scope-on-the-
  credential is the security boundary*, not the URL.

This is why the URL-token path is not "legacy" — it is the **machine** half of
the model. Keep it; give it a scope.

## Open design decisions (the follow-ups)

### A. Consent-time scope picker  (the least-privilege upgrade)

Let the consent screen pick which database(s) — and read/write — an agent may
use, instead of the coarse per-user grant.

- The Better Auth consent endpoint only grants the scope the *client requested*;
  it won't let us inject a user-chosen connection/DB at consent time. So store
  the selection in a side grant table (`client + user → allowed databases +
  access`) and enforce it at the proxy on top of the ownership check. Additive.
- "One endpoint, many connections" is the expensive shape: the engine container
  is per-connection (one MCP session = one container), so spanning connections
  means multiplexing/routing per tool call — an engine change. Cheap shapes:
  per-connection URL (shipped) or a single endpoint bound to one connection.

### B. Connection → database flattening  (the simplification)

The **database** is the irreducible unit (DSN + table policy + guardrails +
tenant scope are per-Postgres). The **connection** as a user-managed object is
the soft layer — for most users it wraps a single DB in ceremony, and OAuth +
the picker dissolve its remaining jobs:

- endpoint/URL → dissolved by OAuth (and further by a single endpoint + picker);
- token boundary → dissolved by OAuth (auth is per-user);
- kill-switch + audit lens → a thin label, not a top-level object.

The one real job it does under the hood — deciding which DBs share an engine
container — becomes *one container per customer fronting all their DBs* (fewer
machines, simpler routing). **Do not drop multi-DB**; the engine's `database:`
support is genuinely useful. Drop the *connection object*, not the capability.

Target user model: a customer has **databases** (flat, each guardrailed); one
OAuth endpoint; **consent/scope picks which databases** an agent may touch.

**Why the name is also wrong (not just the object).** "Connection" had a
defensible origin from the agent's POV — the thing your agent connects through —
but it grew into a *policied group of databases* with a kill-switch and an audit
lens. That is a **project/workspace** in every comparable tool, while a
"connection/data source" elsewhere means a **single** datasource. midplane
borrowed the word from one column and built the object from the other:

- single datasource = "connection"/"data source": hoop.dev, Retool, Metabase;
- group-of-databases + governance = "project": Bytebase (project → databases +
  members/roles), Supabase, Neon;
- access-broker = "resources + roles": StrongDM, Teleport (databases are
  resources; *roles* grant access — the grant, not the resource, is the grouping).

So the hybrid matches neither convention, which is the friction. Flattening to
**databases + scoped access** dissolves the naming problem outright: both terms
are unambiguous and there's no hybrid object to explain.

**The "project" fallback (org/governance wedge, demand-pulled — NOT v1).** The
multi-team case — a DBA partitioning many databases and giving each team a
different scope — is the *paid governance* wedge, and the current connection
serves it badly (per-team access to a shared DB means duplicated connections;
the policy lives on the connection). The right shape there is **RBAC + per-grant
scope** (the ee band — that IS the monetization), optionally grouped by a
**project** (Bytebase's proven model: project → databases + members/roles).
Crucially: the **org/customer is already the top-level workspace** (one org = one
customer), so v1 needs *no* grouping object at all — flat databases under the org.
Reintroduce a grouping only if a real org buyer pulls for it, and call it a
**project**, not a "connection". Do not pre-build it. (No usage data exists
pre-launch; this is reasoned from the model, not observed behavior.)

### C. Headless credential shape

- **Today:** `…/mcp/<token>` (token in the URL path) works now, no browser. Wart:
  secret-in-URL (logs/referer).
- **Target:** the token in `Authorization: Bearer` against the same
  `…/mcp/<id>` URL, so both credential types are bearers behind one endpoint.
- **Later (enterprise):** OAuth `client_credentials` / service accounts (a
  confidential `client_id`+`secret` minting tokens) — standards-grade M2M, but
  more ceremony than a scoped PAT; overkill for the self-serve wedge at v1.

## Sequencing (incremental, each step ships value)

1. **Shipped:** OAuth per-connection URL + the connect guide (interactive agents
   above, headless API tokens below) on the connection page.
2. **Next:** the consent-time scope picker at **database** granularity (A) —
   simultaneously the least-privilege win *and* the wedge toward the flat model.
3. **Then:** put API tokens in a header + give them a DB scope (C) — the headless
   half of the same scope mechanism.
4. **Then:** retire the user-facing "connection" object once the picker makes it
   vestigial (B) — collapse the UI to a flat **database** list under the org;
   one container per customer. The name goes away with the object (no rename to
   ship — you just talk about databases + access). No big-bang migration; it
   falls away. A **project** grouping returns only later, demand-pulled by the
   org/governance wedge (Bytebase-style: project → databases + members/roles),
   alongside ee RBAC — not as a v1 primitive.

## Out of scope (for now)

- Multi-connection-on-one-endpoint (engine is per-connection; real protocol cost).
- `client_credentials` / service-account M2M (enterprise; PAT covers v1 headless).
- Per-agent cryptographic identity beyond OAuth/token bearers (watch item).
