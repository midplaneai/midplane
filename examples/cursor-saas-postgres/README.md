# Cursor + Midplane + your SaaS Postgres

A 5-minute walkthrough: put Midplane in front of your real product DB so Cursor can read it without being able to drop it. The same setup works for Claude Code and Claude Desktop — only the agent config changes.

You'll need Docker, Cursor, and a Postgres connection string for a database you actually care about. We assume the DB lives somewhere reachable from your laptop (Supabase, Neon, RDS, your own VPC, etc.).

## 1. Make a scoped read-only role (30 seconds)

Don't point Midplane at your superuser DSN. Even though Midplane will block writes by policy, defense in depth says the connection itself shouldn't have the privileges to do harm if the policy ever has a bug. Run this against your DB once:

```sql
CREATE ROLE midplane_agent LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE your_db TO midplane_agent;
GRANT USAGE ON SCHEMA public TO midplane_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO midplane_agent;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO midplane_agent;
```

Adjust the schema name if you're not using `public`. The DSN you'll give Midplane is `postgres://midplane_agent:...@your-host:5432/your_db`.

## 2. Run Midplane (1 minute)

```bash
curl -O https://raw.githubusercontent.com/midplaneai/midplane/main/.env.example
mv .env.example .env
# edit .env — set DATABASE_URL to the midplane_agent DSN from step 1

docker run -d \
  --name midplane \
  --env-file .env \
  -p 8080:8080 \
  -v midplane-audit:/data \
  midplane/midplane:latest
```

Verify the MCP endpoint is up:

```bash
curl -s http://localhost:8080/health
# {"ok":true}
```

The audit log is now persisting to the named `midplane-audit` Docker volume.

## 3. Wire Cursor (30 seconds)

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "midplane": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

Reload Cursor. The three Midplane tools (`query`, `list_tables`, `describe_table`) appear in the MCP server list.

## 4. Try it (2 minutes)

In Cursor chat, ask things you'd normally ask of a DB tool:

> "What tables are in the database?"
>
> "Show me the schema of the `users` table."
>
> "How many users signed up in the last 30 days?"

These are reads — they go through Midplane's parse → policy → audit → execute path and return rows.

Now try a destructive prompt:

> "Delete every user whose email ends in `@example.com`."

Cursor will probably ask for confirmation first (the agent's own gate). Confirm. Midplane denies the actual `DELETE` with `policy_rule=writes_require_approval` — read-only is the default. Cursor reports the denial in plain language.

## 5. See the audit row (30 seconds)

The denial was audited **before** Midplane decided not to execute. Confirm:

```bash
docker exec -it midplane sqlite3 /data/audit.db \
  "SELECT ts, event_type, json_extract(payload, '$.statement_type'), json_extract(payload, '$.policy_rule') FROM audit_events ORDER BY id DESC LIMIT 5"
```

You'll see `ATTEMPTED` followed by `DECIDED` with `decision=DENY`, `policy_rule=writes_require_approval`, and the statement type Midplane parsed. No `EXECUTED` row — because the query never ran.

## What to do next

- **Add a tenant-scope rule** if you're a multi-tenant SaaS. One YAML mapping turns "agent can read all tenants" into "agent can only read its own tenant." See [docs/policy-rules.md](../../docs/policy-rules.md) and [docs/self-host.md#configuration](../../docs/self-host.md#configuration).
- **Ship audit to your SIEM.** Midplane exposes pull endpoints (`GET /audit/since`, `DELETE /audit/before`) gated by an `INDEXER_TOKEN` so an external collector can mirror rows out. See [docs/self-host.md#shipping-audit-to-your-own-collector](../../docs/self-host.md#shipping-audit-to-your-own-collector).
- **Wire it into Claude Code or Claude Desktop** instead of (or in addition to) Cursor. The Midplane endpoint stays the same; only the agent config changes. See [docs/agent-setup.md](../../docs/agent-setup.md).
