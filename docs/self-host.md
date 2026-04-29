# Self-host

Run Midplane locally or in your own VPC. Single Docker container. Postgres URL stays in your environment.

## Quick start

```bash
docker run -d \
  --name midplane \
  -e DATABASE_URL=postgres://your-readonly-agent:pass@your-db:5432/your-db \
  -p 8080:8080 \
  -v midplane-audit:/data \
  midplaneai/midplane:latest
```

The MCP endpoint is at `http://localhost:8080/mcp`. The audit log persists at `/data/audit.db` inside the container; mount a volume to survive restarts.

## Wire it into your agent

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "midplane": {
      "transport": "http",
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add midplane http://localhost:8080/mcp
```

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "midplane": {
      "transport": "http",
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `DATABASE_URL` | (required) | Your Postgres connection string. Best practice: a scoped role with least privilege. |
| `PORT` | `8080` | HTTP port for the MCP endpoint. |
| `DB_PATH` | `/data/audit.db` | Path to the local SQLite audit log. |
| `MIDPLANE_TENANT_ID` | (none) | Used by the `tenant_scope` policy rule. See [policy-rules.md](./policy-rules.md). |
| `MIDPLANE_POLICY_FILE` | (none) | Path to a YAML policy override file. Defaults apply if unset. |

## Reading the audit log

The audit log is a plain SQLite database. Open it with anything:

```bash
sqlite3 /var/lib/docker/volumes/midplane-audit/_data/audit.db
> SELECT event_type, COUNT(*) FROM audit_events GROUP BY event_type;
> SELECT * FROM audit_events ORDER BY ts DESC LIMIT 10;
```

Schema: see [packages/engine/src/audit/schema.sql](../packages/engine/src/audit/schema.sql).

## Updating

```bash
docker pull midplaneai/midplane:latest
docker stop midplane && docker rm midplane
# re-run with the same volume mount; audit log carries over
```
