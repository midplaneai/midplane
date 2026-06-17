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
attested retention enforcement, support/SLA.

Shipped:
- `sso/` — SSO/SAML via the Better Auth `sso` plugin (`@better-auth/sso`).
- `register.ts` — the ee boot hook (`registerEe()`).

## How ee loads (the seam)

core (everything under `src/`) must never name `ee/` — not statically (eslint)
and not as a bundler dependency (deleting `ee/` must leave a working MIT build).
But `betterAuth()` needs its plugin list synchronously and `getAuth()` is sync.
The seam threads that needle:

1. `src/lib/ee-plugins.ts` (CORE, no ee import) is a tiny registry:
   `registerEeAuthPlugins()` / `getEeAuthPlugins()`.
2. `src/ee/register.ts` (`registerEe()`) builds the ee plugins and pushes them
   into that registry. ee MAY import core, so this is allowed.
3. `instrumentation.ts` (OUTSIDE `src/` — the sanctioned cloud-only entrypoint)
   dynamically imports `src/ee/register.ts` once at boot, guarded by
   `NEXT_RUNTIME==="nodejs"` && `MIDPLANE_EE==="1"` and wrapped in try/catch.
4. `createAuth()` reads `getEeAuthPlugins()` synchronously (before
   `nextCookies()`). Next awaits `register()` before serving, and auth is built
   lazily on the first request, so the registry is always populated in time.

So the ONLY reference from the always-present graph into `ee/` is the one
guarded line in `instrumentation.ts`. Cloud surfaces gate on
`hasEntitlement("sso")` (the ee build switch AND the Team plan); they call the
Better Auth SSO HTTP endpoints, so no `src/` file imports `ee/`.

**Producing an MIT build:** delete `src/ee/`, drop the ee bootstrap block in
`instrumentation.ts`, and leave `MIDPLANE_EE` unset. The eslint boundary
guarantees nothing else needs touching.

## Activation (recap)

`MIDPLANE_EE=1` turns ee on for a deployment (`eeEnabled()` in `./index.ts`).
The signed-license verifier is deferred (design doc, D3). Self-host stays keyless
(flag unset) — SSO dark, core uncapped.

See: `~/.gstack/projects/midplaneai-midplane-cloud/` — open-core design doc +
feature manifest + eng plan.
