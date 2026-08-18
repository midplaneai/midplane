---
status: PARTIALLY IMPLEMENTED
---
# Credentials & scope model: interactive vs headless agents

Captures the credential model behind the MCP OAuth path and sequences three
related follow-ups: the consent-time scope picker, the connection→database
flattening, and headless (machine) credentials.

> **Two notes before reading.** (1) The per-agent scope picker described under
> "Open design decisions → A" has since **shipped** — see "Per-agent scope
> (shipped)" below; the coarse per-user grant it describes is no longer the
> enforced model. (2) This document predates the **connection → project**
> rename. Where it says "connection", read "project": the container object that
> holds one or more databases.

## What shipped first (OAuth)

The `/mcp` proxy is now an OAuth 2.1 resource server (Better Auth `mcp` plugin).
An interactive agent (Claude Code, Cursor, Claude Desktop) points at a
per-connection URL `…/mcp/<connectionId>`; with no/invalid bearer it gets a 401 +
`WWW-Authenticate` discovery challenge and runs the OAuth flow natively (browser
sign-in → consent → token). The proxy maps the OAuth user → their customer,
checks they own the connection, mints one `kind='oauth'` attribution row per
(connection, OAuth client), and forwards — stamping the same per-agent
`mcp_token_id` the URL-token path stamps. The legacy `…/mcp/<token>` HMAC path is
preserved.

Two properties of that first cut were deliberately coarse, and motivated the
model below:

1. **The token authorized the *user*, not a project.** The per-project URL
   selected what the agent talked to, but the same bearer worked on any project
   the user owned (the proxy checked ownership, not a per-grant restriction).
   **This is no longer the case — see below.**
2. **The project id is not a secret.** Auth is the OAuth sign-in, so the URL is
   just an address — shown openly with a copy button, no show-once.

## Per-agent scope (shipped)

Property 1 above has been closed. Access is now bound to the *credential*, not
just to ownership:

- `mcp_scope_grants` (migration 0028) stores, per credential, which databases it
  may reach and at what access level. `setOAuthGrants` writes the interactive
  side (keyed `client_id` + `user_id`, chosen in the consent DB picker);
  `setTokenGrants` writes the headless side (keyed `mcp_token_id`, chosen at
  token creation). Both are replace-all within their key, so re-consenting never
  leaves stale rows, and every selection is ownership-validated before it lands.
- The proxy resolves the grant (`resolveScope`) and passes it to the engine as
  `X-Midplane-Scope`. It **deletes any client-supplied value first**, so an
  unscoped credential cannot smuggle a scope in. Scope only ever narrows.
- A headless token with **no** grant rows resolves to `{}` — scope active, zero
  databases — not "unscoped". Deleting a database cascades its grants, so a token
  scoped to exactly that database fails closed rather than widening.
- A credential that reaches a project it has no grant for gets a 403-equivalent
  `insufficient_scope` challenge telling the agent to re-connect and choose
  databases.

The remaining unscoped case is a credential with a `null` grant, which predates
the scope model and is treated as full access for continuity.

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

### A. Consent-time scope picker  (the least-privilege upgrade) — **SHIPPED**

> Implemented as described. See "Per-agent scope (shipped)" above for the
> as-built behaviour; the rest of this section is the original reasoning.

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

### C. Headless credential shape

- **Today:** `…/mcp/<token>` (token in the URL path) works now, no browser. Wart:
  secret-in-URL (logs/referer).
- **Target:** the token in `Authorization: Bearer` against the same
  `…/mcp/<id>` URL, so both credential types are bearers behind one endpoint.
- **Later (enterprise):** OAuth `client_credentials` / service accounts (a
  confidential `client_id`+`secret` minting tokens) — standards-grade M2M, but
  more ceremony than a scoped PAT; overkill for the self-serve wedge at v1.

## Sequencing (incremental, each step ships value)

1. **Shipped:** OAuth per-project URL + the connect guide (interactive agents
   above, headless API tokens below) on the project page.
2. **Shipped:** the consent-time scope picker at **database** granularity (A) —
   simultaneously the least-privilege win *and* the wedge toward the flat model.
3. **Shipped (scope half):** headless tokens carry a DB scope via the same
   `mcp_scope_grants` mechanism (`setTokenGrants`). Moving the token itself from
   the URL path into an `Authorization: Bearer` header (C) is still open.
4. **Open:** retire the user-facing project container once the picker makes it
   vestigial (B) — collapse the UI to a flat database list; one container per
   customer. No big-bang migration; it falls away.

## Out of scope (for now)

- Multi-connection-on-one-endpoint (engine is per-connection; real protocol cost).
- `client_credentials` / service-account M2M (enterprise; PAT covers v1 headless).
- Per-agent cryptographic identity beyond OAuth/token bearers (watch item).
