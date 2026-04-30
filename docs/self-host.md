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

### Why not `-e DATABASE_URL=postgres://...` inline?

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
| `DATABASE_URL` | (required) | Your Postgres connection string. Best practice: a scoped role with least privilege. |
| `PORT` | `8080` | HTTP port for the MCP endpoint. |
| `DB_PATH` | `/data/audit.db` | Path to the local SQLite audit log. |
| `MIDPLANE_TENANT_ID` | (none) | Used by the `tenant_scope` policy rule. See [policy-rules.md](./policy-rules.md). |
| `MIDPLANE_POLICY_FILE` | (none) | Path to a YAML policy override file. Defaults apply if unset. |
| `INDEXER_TOKEN` | (none) | Bearer token for the audit pull endpoints. Unset → endpoints return 404. See [Shipping audit to your own collector](#shipping-audit-to-your-own-collector). |

## Reading the audit log

The audit log is a plain SQLite database. Open it with anything:

```bash
sqlite3 /var/lib/docker/volumes/midplane-audit/_data/audit.db
> SELECT event_type, COUNT(*) FROM audit_events GROUP BY event_type;
> SELECT * FROM audit_events ORDER BY ts DESC LIMIT 10;
```

Schema: see [packages/engine/src/audit/schema.sql](../packages/engine/src/audit/schema.sql).

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
