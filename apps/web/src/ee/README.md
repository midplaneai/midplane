# ee/ — Enterprise Edition (commercial)

Code in this directory is the commercial **Enterprise Edition**. It is **not MIT**.
Everything else in the control plane (outside `ee/`) is MIT core.

## The open-core boundary (CI-enforced)

- MIT core must **never** import from `ee/`.
- `ee/` **may** import from core.

So deleting `ee/` always leaves a working MIT build. The rule is enforced by
`no-restricted-imports` in `apps/web/eslint.config.mjs` (runtime imports — the
licensing/bundle invariant; type-only imports aren't caught, upgrade to the
typescript-eslint variant if core ever type-depends on `ee/`).

## Activation

Enterprise features are gated at runtime by a flag (`eeEnabled()` in `./index.ts`).
The signed-license verifier is **deferred** (open-core design doc, decision D3):
for now the flag is a simple env check; real license verification lands when
there is a paying self-host customer to enforce against.

## What lives here

Per the feature manifest (core / ee / cloud / metering), the `ee` band is:
SSO/SAML enforcement, SCIM, fine-grained RBAC, approvals, dynamic masking,
attested retention enforcement, support/SLA. First feature to land (P5):
**SSO** via the Better Auth `sso` plugin.

See: `~/.gstack/projects/midplaneai-midplane-cloud/` — open-core design doc +
feature manifest + eng plan.
