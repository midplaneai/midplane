# Security policy

If you find a security vulnerability in Midplane, please report it privately.

**Email:** security@midplane.com (placeholder — verify before V1 launch)

Please include:
- A description of the vulnerability and the affected version(s)
- Steps to reproduce, or proof-of-concept
- Your proposed remediation, if any

We aim to acknowledge within 2 business days. We coordinate disclosure and credit reporters in release notes once a fix ships.

Please do not open public issues for vulnerabilities. We treat security reports as the highest priority.

## Scope

In scope:
- The engine (`@midplane/engine`) — parse, policy, audit, execute pipeline
- The MCP server (`@midplane/mcp-server`)
- The published Docker image (`midplane/midplane` on Docker Hub, `ghcr.io/midplaneai/midplane` on GHCR)

Out of scope:
- Third-party dependencies (libpg_query, MCP SDK, bun:sqlite, etc.) — please report upstream
- The hosted product (`midplane.com`) — covered by a separate disclosure policy
- The customer's own database, network, or agent configuration
