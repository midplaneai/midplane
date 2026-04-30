# Trust posture

The honest version of "what does Midplane do with my data?"

| Concern | Self-host (Flow B) | Hosted (Flow A) |
|---|---|---|
| Where do my DB credentials live? | Your environment. Never leave your network. | Encrypted at rest with AWS KMS using a per-tenant key. Decrypted into process memory at query time and held cached for up to 10 minutes (with up to 60 additional minutes of grace if KMS is unreachable, after which new sessions are refused). Connection pools are kept warm during this window. The decrypted credential never leaves the process and is never written to disk. |
| Who can read my queries? | Only you. | Midplane infrastructure operators with database access, until the audit retention window expires (Free tier: 7 days; Pro: 90 days; Team: 1 year). |
| What if Midplane is breached? | Not affected. Self-host has no Midplane-controlled infrastructure. | Encrypted credentials, no plaintext exposed at rest. The in-flight working set (decrypted credentials in cache + warm connection pools) is the residual exposure during the breach window. |
| What if I want to leave? | Stop the container. | Delete account; we wipe credentials immediately and audit data after the standard retention period. Audit log is exportable any time. |
| Audit log location | Your local SQLite at `/data/audit.db` inside the container. | Postgres on Neon (multi-AZ replicated) plus a per-pod SQLite as fallback queue when Postgres is unavailable. |
| Can I read the source? | Yes. The Docker image is built from this public, MIT-licensed repo. | Yes — same engine. The hosted product wraps this engine with auth and dashboard but doesn't fork it. |
| SSO / SAML | Enterprise self-host (later phase). | Team plan and above (later phase). |

## Threat model

Read [THREAT_MODEL.md](../THREAT_MODEL.md) before pasting your connection string.

## What we DON'T claim

- "We don't see your queries." We do. We log every query as the audit record.
- "Your data never leaves your DB." Query results pass through Midplane in memory on the way back to your agent. We don't persist results, but they exist in our process for the duration of the response.
- "We are SOC 2 certified." Not yet. SOC 2 work is on the long-term roadmap, gated by enterprise demand.

## What we DO claim

- AST-based parsing. No regex on SQL. Not now, not ever.
- The same Docker image runs in our infrastructure and on your machine. The trust posture difference is "where the container runs," not "what code runs."
- Audit-fail-fails-the-query. If the audit write fails, the query does not execute.
- The OSS engine is MIT. No copyleft. No BSL. No "source-available." The license stays MIT, forever.
