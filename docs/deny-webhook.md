# Deny webhook

`MIDPLANE_DENY_WEBHOOK` fires a JSON `POST` on every policy denial. Generic — works with Slack incoming webhooks, Discord webhooks, the PagerDuty Events API, or any HTTP endpoint.

Useful when you want a denial to trigger an active signal (a Slack ping, an on-call page) rather than waiting for someone to query the audit log.

## Configuration

```bash
MIDPLANE_DENY_WEBHOOK=https://hooks.slack.com/services/T000/B000/xxx
# Optional: only fire for specific rules (comma-separated).
# Unset = fire on every denial.
MIDPLANE_DENY_WEBHOOK_RULES=writes_require_approval,multi_statement
```

URL must be `http://` or `https://`; anything else fails fast at boot.

## Payload

`POST {url}` with `content-type: application/json` and:

```json
{
  "event": "denial",
  "schema_version": 1,
  "ts": 1730000000000,
  "query_id": "01HXXX...",
  "audit_id": "01HXXX...",
  "tenant_id": "__self_host__",
  "agent_identity": null,
  "policy_rule": "writes_require_approval",
  "reason": "Midplane denied this query because writes require approval.",
  "statement_type": "DELETE",
  "tables_touched": ["public.users"],
  "sql_preview": "DELETE FROM users WHERE id = 42",
  "sql_truncated": false
}
```

`sql_preview` is truncated at 1024 characters; `sql_truncated` flags when truncation occurred. Both are empty/false when the engine could not match an `ATTEMPTED` row to the denial (rare — only happens under buffer pressure).

## Reliability

- Fire-and-forget. The webhook POST has a 5 second timeout.
- Webhook failure (network error, HTTP 5xx, slow endpoint) **never** blocks or fails the underlying audit write. The `DECIDED` row in the audit log is the source of truth; the webhook is a notification.
- No retries. If the receiver is down, the denial is still recorded; the webhook just doesn't fire for that event.
- The receiver must accept any 2xx response; status codes are ignored.

## Slack quickstart

1. Create an Incoming Webhook in Slack and copy the `https://hooks.slack.com/services/...` URL.
2. Set `MIDPLANE_DENY_WEBHOOK=...` in `.env`.
3. Slack will render the JSON as a code block. For prettier formatting, point the webhook at a small relay (Cloudflare Worker, Lambda) that translates the payload into Slack Block Kit. The default JSON is intentionally generic.

## Filtering

`MIDPLANE_DENY_WEBHOOK_RULES` accepts a comma-separated list of [policy rule names](./policy-rules.md). Recognized values:

- `writes_require_approval`
- `multi_statement`
- `tenant_scope_missing`
- `parse_error`

A query that matched a rule not in the allowlist still produces an audit row, but does not fire the webhook.
