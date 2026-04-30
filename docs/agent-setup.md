# Agent setup

Verified copy-paste configs for connecting Cursor, Claude Code, and Claude Desktop to a running Midplane MCP endpoint.

> **Status:** Live trace ran 2026-04-29 against a local container booted via `scripts/agent-smoke.sh`. All three agents connected and listed the three V1 tools. Per-prompt verification depth varies — see each agent's section below for what was specifically exercised.

## Before you start

Boot a Midplane container with Postgres reachable. Use `--env-file` (or `docker compose up`) — never pass `DATABASE_URL` inline, since it leaks to `ps aux` and shell history.

```bash
cp .env.example .env  # edit with your DATABASE_URL
docker run -d --name midplane \
  --env-file .env \
  -p 8080:8080 \
  -v midplane-audit:/data \
  midplane/midplane:latest
```

Or, from a clone of this repo, run [`scripts/agent-smoke.sh`](../scripts/agent-smoke.sh). It boots the image with a sidecar Postgres, **seeds a tiny demo schema** (`public.users` and `public.posts`, two rows each), prints all three configs below pre-filled with the right port, and tails `/data/audit.db` so you can watch your agent's traffic land in real time.

The MCP endpoint is `http://localhost:8080/mcp`. The audit log is `/data/audit.db` inside the container.

---

## Cursor

Verified 2026-04-29.

### Config

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

Cursor auto-detects Streamable HTTP from the URL endpoint; no `transport` or `type` key is needed.

### First handshake

Verified 2026-04-29: after saving the config, Cursor's MCP panel lists three tools (`query`, `list_tables`, `describe_table`).

### Demo paths

Run each prompt in chat (assuming the seeded `users` / `posts` demo schema from `agent-smoke.sh`). The first three exercise the three V1 tools on the happy path; the last three exercise the three V1 policy denials. Confirm each denial's reason renders cleanly in the chat (not buried in a stack trace).

| # | Prompt | Expected tool | Expected result | Audit row |
|---|---|---|---|---|
| 1 | "What tables are in the database?" | `list_tables` | `users`, `posts` | `ATTEMPTED → DECIDED → EXECUTED` |
| 2 | "What columns does the users table have?" | `describe_table` | 4 columns: id, email, org_id, created_at | `ATTEMPTED → DECIDED → EXECUTED` |
| 3 | "Show me the first 5 rows of the users table." | `query` | 2 rows returned | `ATTEMPTED → DECIDED → EXECUTED` |
| 4 | "Delete all users." | `query` (`DELETE FROM users`) | Denied; reason: *"Midplane denied this query because writes are read-only by default in V1."* `policy_rule=writes_require_approval`. | `ATTEMPTED → DECIDED` |
| 5 | "Run this SQL: `SELECT 1; DROP TABLE users`" | `query` | Denied; `policy_rule=multi_statement`. | `ATTEMPTED → DECIDED` |
| 6 | "Run this SQL: `this is not sql`" | `query` | Denied; `policy_rule=parse_error`. | `ATTEMPTED → DECIDED` |

### Quirks

None observed at the connection / handshake layer. Per-prompt traces in Cursor specifically have not been individually captured — exhaustive transcripts will follow when we collect launch-day screenshots.

---

## Claude Code

Verified 2026-04-29.

### Config

```bash
claude mcp add --transport http midplane http://localhost:8080/mcp
```

The `--transport http` flag is **required**. Without it, the CLI defaults to stdio and treats the URL as a launcher command, which fails silently. To verify the server registered:

```bash
claude mcp list
```

### First handshake

Verified 2026-04-29: three tools appear under `claude mcp list` once the server registers; tool calls in chat go through Midplane.

### Demo paths

Same six-row demo table as Cursor. The `writes_require_approval` denial path was exercised end-to-end and is documented below.

#### Transcript: `writes_require_approval`

User: *"delete all users"*

> ⏺ Hold on — that's destructive and irreversible. Before I run `DELETE FROM public.users` (which would also likely cascade or break posts if there's a FK), please confirm:
>
>   1. You really want to wipe all 2 users from this database.
>   2. This is the intended environment (Midplane is connected to whatever DB it's pointed at — I haven't verified it's a dev/test DB).
>
> If yes to both, reply "confirm delete all users" and I'll run it. Otherwise, tell me the actual scope (e.g., a specific user, a soft-delete flag, a test DB only).

User: *"confirm delete all users"*

> Called midplane (ctrl+o to expand)
>
> ⏺ Midplane blocked it — policy `writes_require_approval` is enforced and the connection is read-only in V1. The DELETE was audited but not executed.

Two enforcement layers visible to the user: Claude Code's own confirmation prompt before any destructive call, then Midplane's policy denial. The Midplane reason string (`writes_require_approval`, read-only by default) surfaces cleanly in Claude Code's natural-language summary.

### Quirks

- Claude Code applies its own pre-write confirmation gate, so a denied write surfaces twice (Claude's confirmation prompt → user confirms → Midplane denies). This makes the V1 trust story more visible, not less. Read paths skip the gate entirely.

---

## Claude Desktop

Verified 2026-04-29.

Claude Desktop has two paths to attach a remote MCP server, and **which one works depends on whether your Midplane is local or hosted**:

| Deployment | URL scheme | Working path |
|---|---|---|
| Self-host (local) | `http://localhost:8080/mcp` | `mcp-remote` config-file shim |
| Hosted Midplane | `https://…midplane.ai/mcp/<token>` | Custom Connectors UI |

The Custom Connectors UI **rejects `http://`** (Anthropic enforces HTTPS as a baseline). It also can't accept a self-signed cert against `localhost`. So for local self-host the only supported path is `mcp-remote`, which proxies stdio↔HTTP locally.

### Config — self-host (`claude_desktop_config.json`)

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

`mcp-remote` is a Node-based stdio↔HTTP bridge; this requires `npx` (Node.js) on `PATH`. Restart Claude Desktop after editing the file.

### Config — hosted (Custom Connectors UI)

When you connect to a Midplane hosted endpoint at `https://…midplane.ai/mcp/<token>`:

1. Settings → Connectors → **Add custom connector**.
2. Name: `midplane`. URL: your hosted endpoint.
3. Save. Tools become available in chat within a few seconds.

This path doesn't work for `http://localhost`; see the table above.

### First handshake

Verified 2026-04-29: after editing the config file and restarting Claude Desktop, the three Midplane tools become available in chat (the `mcp-remote` child process spawns and bridges stdio↔HTTP).

### Demo paths

Same six-row demo table as Cursor.

### Quirks

- **Restart required** after editing `claude_desktop_config.json` — new MCP servers don't hot-reload.
- **Custom Connectors UI rejects `http://`** (Anthropic enforces HTTPS) and won't accept self-signed certs against `localhost`. For local self-host, the `mcp-remote` config-file path is the only working route. Hosted Midplane (HTTPS endpoint) uses Custom Connectors normally.
- **`npx` on PATH required** — `mcp-remote` is a Node package fetched on demand. If Node isn't installed, the connector silently fails to spawn.

---

## Reproducing the verification

- [`scripts/agent-smoke.sh`](../scripts/agent-smoke.sh) — local boot + audit-tail.
- [`packages/mcp-server/verify-mcp-handshake.ts`](../packages/mcp-server/verify-mcp-handshake.ts) — wire-level Streamable HTTP verifier (no MCP SDK; raw `fetch`). Catches protocol drift independently of any installed agent. Runs as part of `bun test`; can also be pointed at a running container with `SERVER_URL=http://localhost:8080/mcp bun run packages/mcp-server/verify-mcp-handshake.ts`.

If you reproduce the six demo prompts in any of the three agents and audit rows land with the correct `event_type` sequence, the wire is healthy.
