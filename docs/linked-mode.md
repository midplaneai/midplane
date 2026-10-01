# Linked mode

`midplane gateway` enforces what a project in Midplane Cloud publishes:
policies authored in the dashboard, agents' identities, approvals, taint shared
by every instance, and a query log. The gateway opens every connection; the
cloud never connects to it, and it serves nothing for the cloud to call.

```yaml
# midplane.yaml
listen: { host: 127.0.0.1, port: 7433 }
public_urls: [https://db-gateway.internal.example.com]
audit: { file: audit.db }
mask_salt: { env: MIDPLANE_MASK_SALT }
link:
  cloud_url: https://midplane.example.com   # as the project's Gateways page shows it
  identity: { file: identity.json }
  enrollment_token: { env: MIDPLANE_ENROLLMENT_TOKEN }
  name: prod-eu-1
databases:
  main: { dsn: { env: DSN_MAIN } }
```

The database ids (`main`) are the ones the project's databases use in the
dashboard.

## Enrollment

A project manager makes an enrollment token on the project's Gateways page.
It works once, within 24 hours, and pins Midplane Cloud's signing key: the
gateway refuses an answer signed with any other key, so a TLS-inspecting proxy
can't stand in for the cloud.

- **On a disk:** with `link.identity: { file: identity.json }`, the first
  start enrolls with the token and writes the identity (mode 0600). Later
  starts read it and never need the token again.
- **Without a disk** (a platform that rebuilds containers): run
  `midplane enroll --config midplane.yaml` once. It prints the identity as one
  line of JSON; store it in your secret manager and point
  `link.identity: { env: MIDPLANE_IDENTITY }` at it. `--out <file>` writes it
  to a file instead.

The identity holds the gateway's private key: treat it like a password
([secrets](secrets.md)). Enrolling registers every URL in `public_urls` (or
the listener's) as one of the gateway's URLs ([hosted agents](hosted-agents.md)).

## Bundles

A bundle is a project's complete policy, signed by Midplane Cloud when someone
publishes. The gateway takes one only if its signature, issuer, project and
version check out, and only if it is newer than the one it holds.

- **Enforcing:** the newest bundle is written to `link.bundle_cache` before it
  takes effect. After a restart with the cloud down, the gateway enforces it
  again.
- **Waiting:** a gateway that has never received a bundle serves nothing (503).
- **Halted:** an authentic bundle the gateway can't fully enforce (a newer
  format, a policy feature it doesn't know, masks without `mask_salt`) halts
  it: every call is refused, and the dashboard and the log say why. Upgrade
  the gateway, or fix its config.
- **Paused:** a paused project's gateways refuse every call until it's
  resumed.

A published change reaches a running gateway within a second or two: it waits
on a long poll of up to 50 seconds that the cloud answers as soon as there is
news.

## What goes up

Over the link, a gateway sends its status (bundle version, state, version,
features, database ids, URLs), each database's catalog (table and column names
and types, view definitions with every literal replaced, never a value), held
writes for approval, taint records, and its audit log ([audit](audit.md)). It
never sends a DSN, the salt, or a row.

The cloud's ack of each audit batch is signed like its other answers, for a
nonce the gateway sends, and names the hash of the event it stored at the
acked sequence, the hash of the request body it received, and the batch's
first event it already holds under another hash, if any: it stores a batch
only up to there. The gateway stops owing events only on an ack that verifies
for the bytes it sent, and only up to such a conflict, sending the rest as a
new instance, so a proxy can't make it forget events the cloud never got,
whether it forwards part of a batch or stores a forged copy first. The
event hashes the cloud holds are keyed with a secret that stays in the audit
file, so it can't test a guess at a statement's values against them.

## Replicas

Several processes may share one identity (the same `MIDPLANE_IDENTITY`), each
with its own audit file. They share approvals and taint through the cloud: an
agent tainted on one is tainted on all. On one cloud instance, replicas of one
identity take turns holding the long poll, so each syncs about once a second.
They take turns pushing audit batches too: one turned away (a 429) tries again
a few seconds later, and doesn't log it as a failure unless the 429s go on
for two minutes. Give each replica a file of its own: a copied file goes on
as a new instance once the cloud names the other's event at one of its
sequences. Local processes may share a file; linked ones may not.

## Revoking

Revoking a gateway on the Gateways page cuts its link: it can't get new
bundles or file held writes. It keeps enforcing its last bundle, and
personal access tokens it already accepts keep working there until they
expire, so stop the process as well.

*Tested by* `apps/gateway/test/link.e2e.test.ts` (enrollment and the pin,
bundles, halting, pausing, restarts with the cloud down, revocation, no
inbound connection), against a stand-in for the cloud, and CI's `package`
job (`enroll` and `gateway` from the npm package).
