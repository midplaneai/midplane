# Security Policy

Midplane sits in the query path between AI agents and production databases, so
we take security reports seriously and respond quickly.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately to **security@midplane.ai**. If you prefer, use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository.

Include, where possible:

- A description of the issue and its impact.
- Steps to reproduce (a minimal proof of concept helps).
- Affected component — this control plane, or the engine
  ([`midplaneai/midplane`](https://github.com/midplaneai/midplane), reported there).

We aim to acknowledge within 3 business days and to keep you updated through
triage and the fix. Please give us a reasonable window to remediate before any
public disclosure; we're happy to credit you.

## Scope

This repository is the control plane (dashboard, connection/policy management,
audit, hosted MCP proxy, auth, billing). The query-path engine is a separate
repository with its own reporting path. Of particular interest here:

- Tenant isolation (cross-customer data exposure) — audit reads are guarded by
  Postgres row-level security; a bypass is high severity.
- Authentication / session handling, the MCP OAuth flow, and SSO/SAML
  (Enterprise Edition).
- Credential storage (encrypted DSNs) and the KMS path.

## Supported versions

Pre-launch, only the latest `main` is supported. Once we tag releases, this
section will list supported versions.
