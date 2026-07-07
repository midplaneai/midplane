# Self-host

Run Midplane locally or in your own VPC. Single Docker container. Postgres URL stays in your environment.

## Quick start

### Option A — `docker compose` (recommended)

From a clone of this repo:

```bash
cp .env.example .env  # edit with your DATABASE_URL
docker compose up -d
```

`compose.yaml` ships with the named `midplane-audit` volume mounted at `/data` and a healthcheck against `/health`.

### Option B — `docker run` with `--env-file`

```bash
cp .env.example .env  # edit with your DATABASE_URL
docker run -d \
  --name midplane \
  --env-file .env \
  -p 8080:8080 \
  -v midplane-audit:/data \
  midplane/midplane:latest
```

### Why not pass the DSN inline with `-e`?

The expanded credential ends up in `ps aux` (visible to any user on the host) and in your shell history. `--env-file` keeps the secret in a file you can `chmod 600`. Same reason we ship `.env.example` and gitignore `.env`.

The MCP endpoint is at `http://localhost:8080/mcp`. The audit log persists at `/data/audit.db` inside the container; the named volume survives restarts.

## Wire it into your agent

See [docs/agent-setup.md](./agent-setup.md) for verified per-agent configs, demo prompts, and known quirks. Quick reference:

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "midplane": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http midplane http://localhost:8080/mcp
```

The `--transport http` flag is required — without it the CLI defaults to stdio.

### Claude Desktop

For local self-host, the Custom Connectors UI doesn't work — it requires HTTPS and rejects `http://localhost`. Use the `mcp-remote` config-file shim instead.

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "midplane": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8080/mcp"]
    }
  }
}
```

Requires `npx` (Node.js) on `PATH`. Restart Claude Desktop after editing.

(Hosted Midplane at `https://…midplane.ai/mcp/<token>` uses Custom Connectors; see [agent-setup.md](./agent-setup.md#config--hosted-custom-connectors-ui) for both paths.)

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `DATABASE_URL` | (required for single-DB; ignored when YAML `databases:` is set) | Your Postgres connection string. Best practice: a scoped role with least privilege. |
| `PORT` | `8080` | HTTP port for the MCP endpoint. |
| `MIDPLANE_HOST` | `0.0.0.0` | HTTP bind address. The default (`0.0.0.0`) serves IPv4. Set to `::` for dual-stack (IPv6 + IPv4 on Linux, where `bindv6only=0`) — required when the server must be reachable over an IPv6-only network. |
| `DB_PATH` | `/data/audit.db` | Path to the local SQLite audit log. |
| `MIDPLANE_TENANT_ID` | (none) | Used by the `tenant_scope` policy rule. See [policy-rules.md](./policy-rules.md). |
| `MIDPLANE_POLICY_FILE` | (none) | Path to a YAML policy override file. Defaults apply if unset. **0.2.0:** may carry a top-level `databases:` block for serving multiple Postgres DBs through one MCP endpoint — see the README's "Multiple databases" section. |
| `MIDPLANE_DENY_WEBHOOK` | (none) | If set to an `http(s)://` URL, every policy denial fires a JSON `POST` to it. See [deny-webhook.md](./deny-webhook.md). |
| `MIDPLANE_DENY_WEBHOOK_RULES` | (all rules) | Comma-separated allowlist of policy rule names that trigger the webhook. |
| `INDEXER_TOKEN` | (none) | Bearer token for the audit pull endpoints. Unset → endpoints return 404. See [Shipping audit to your own collector](#shipping-audit-to-your-own-collector). |

## Authoring the policy file

`MIDPLANE_POLICY_FILE` is a YAML file, but you don't have to write it blind.

The fastest path is the interactive wizard — it connects to your database (read-only), detects likely tenant columns (`tenant_id`, `org_id`, … shown with how many tables carry each), lets you pick per-table write grants and denies, and writes a validated, linted policy file plus the docker/agent commands to finish:

```bash
midplane init
```

(`init` needs a terminal; everything below is the flag-driven equivalent for scripts and CI.) The same `midplane` binary ships a `policy` CLI that scaffolds, validates, lints, and dry-runs a policy.

```bash
# Scaffold from a live database: lists every table in the `public` schema and
# emits each under table_access (default: read). --tenant-column turns on strict
# tenant scoping. The DSN is never written into the file, so redirect stdout.
# Note the container shell (sh -lc): DATABASE_URL must expand INSIDE the
# container, not on your host — the redirect stays on the host.
docker exec midplane sh -lc 'midplane policy init --url "$DATABASE_URL" --tenant-column tenant_id' > policy.yaml

# No --url? Emit a static starter template to edit by hand.
docker exec midplane midplane policy init > policy.yaml

# Schema-check it against the exact schema the server boots with.
midplane policy validate policy.yaml

# Security-posture review: read_write defaults, ungated tables, missing
# tenant_scope, audit tables left scoped. Exits nonzero on any [ERROR].
midplane policy lint policy.yaml

# Dry-run a query against the policy — no DB connection. Prints ALLOW/DENY,
# the rule, and the exact message the agent would see on a denial.
midplane policy test policy.yaml --sql "DELETE FROM users WHERE tenant_id = 'acme'" --tenant-id acme

# Same question, asked of the RUNNING server's currently-loaded policy via
# POST /admin/dry-run. The file on disk and the loaded policy can differ
# (edited but not pushed/restarted) — this checks the live one. Requires
# the server's INDEXER_TOKEN.
midplane policy test --server --token "$INDEXER_TOKEN" --sql "DELETE FROM users"
```

`validate` and `lint` are good CI gates — both exit nonzero on a bad/dangerous policy. Run `midplane policy help` for the full reference.

## Verifying the install

`midplane doctor` runs the checks in boot order — env config, policy file (validate + lint), database connectivity (`SELECT 1` per configured DB, DSN never echoed), audit store, `/health`, and an end-to-end MCP canary. Any failure exits nonzero; the text output is what to paste into a GitHub issue.

```bash
docker exec midplane midplane doctor
```

`midplane query` sends one statement through the running server **exactly as an agent would** — same MCP `query` tool, same policy, same audit row (stamped `agent_name=midplane-cli`), same deny message. If this works, point your agent at the same URL.

```bash
# The smoke test: end-to-end ALLOW.
docker exec midplane midplane query --sql "SELECT 1"

# Verify the policy actually blocks what you think it blocks — exits 1 on DENY
# and prints the exact message the agent would read.
docker exec midplane midplane query --sql "DELETE FROM users" --intent "verify the write block"

# stdio-transport setups (no HTTP listener): spawn a child server instead.
midplane query --stdio --sql "SELECT 1"
```

It's deliberately not a database client — one shot, no REPL; use `psql` for actual SQL work.

## Reading the audit log

The container ships a `midplane audit` CLI that wraps the local SQLite log. No SQL required. `tail`/`since`/`denies`/`show` print human-readable (aligned, colored) output on a TTY and JSON lines when piped — `--json` / `--pretty` force either; `stats` prints its text summary either way (`--json` for the machine shape). Color respects `NO_COLOR`.

```bash
# Live stream (Ctrl-C to stop). Backfills the last 10 events first.
docker exec -it midplane midplane audit tail

# The question you actually ask: what got denied, and why? Each denial shows
# the blocked SQL, the rule, the agent-facing reason, and the agent's intent.
docker exec -it midplane midplane audit denies --since 1h

# Forensics on one query: agent, intent, full SQL, and the
# ATTEMPTED → DECIDED → EXECUTED/FAILED chain. Takes the qid=... from any line.
docker exec -it midplane midplane audit show <query_id>

# One-shot dump of everything in the last hour. Accepts 30m, 7d, 1d12h, etc.
docker exec midplane midplane audit since 1h

# Summary over a window (default 24h): event types, deny rules, top agents.
docker exec midplane midplane audit stats
docker exec midplane midplane audit stats --since 7d --json
```

Piped output is one JSON object per line — `jq` filters compose as expected:

```bash
docker exec midplane midplane audit tail \
  | jq 'select(.event_type == "DECIDED" and .payload.decision == "DENY")'
```

If you need raw SQL access, the database is still a plain SQLite file at `/data/audit.db` inside the container (volume `midplane-audit`). Schema: see [packages/engine/src/audit/schema.sql](../packages/engine/src/audit/schema.sql).

## Shipping audit to your own collector

Two HTTP endpoints let an external indexer (your SIEM, your warehouse loader, the Midplane hosted indexer) pull audit rows in cursor order and acknowledge them after they're durable downstream. They're **opt-in** — set `INDEXER_TOKEN` to enable; unset, both routes return `404` so the routes don't appear to exist.

Generate a token and append it to `.env`. Docker's `--env-file` is **not a shell** — it doesn't expand `$(...)` — so generate the value first, then write the literal hex:

```bash
echo "INDEXER_TOKEN=$(openssl rand -hex 32)" >> .env
```

Then `docker compose up -d` (or restart the container) so the new env reaches the process. Export the same value into your shell so the curl examples below work:

```bash
export INDEXER_TOKEN=$(grep ^INDEXER_TOKEN= .env | cut -d= -f2-)
```

### `GET /audit/since/<cursor>?limit=N`

Pulls rows with `id > cursor` in ascending `id` order. Pass `0` (or any sentinel that sorts below the smallest ULID) to start from the beginning.

- `limit` defaults to `500`, max `1000`.
- Response: `{ "rows": [...], "next_cursor": "<id>" | null }`. `next_cursor` is `null` when the page was short (no more rows).
- Auth: `Authorization: Bearer <INDEXER_TOKEN>`. Constant-time comparison; `401` on any mismatch.

```bash
curl -sH "Authorization: Bearer $INDEXER_TOKEN" \
  "http://localhost:8080/audit/since/0?limit=100"
```

### `DELETE /audit/before/<id>`

Deletes rows with `id <= <id>` (inclusive). Use this **after** the rows are durable in your collector. Idempotent — re-deleting already-deleted rows returns `{ "deleted": 0 }`.

```bash
curl -sX DELETE -H "Authorization: Bearer $INDEXER_TOKEN" \
  "http://localhost:8080/audit/before/<last-id-you-confirmed>"
```

Pull-then-delete is the contract; do not call `DELETE` for rows you haven't read out yet.

## Updating

```bash
docker pull midplane/midplane:latest
docker stop midplane && docker rm midplane
# re-run with the same volume mount; audit log carries over
```
