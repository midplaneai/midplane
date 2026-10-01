# Install

The gateway is one Node process. It needs **Node 24.16 or newer** (it uses
Node's built-in SQLite for its audit log, and 24.16 fixes a text-truncation
bug in it) and a network path to your databases. It has no native modules.

## With npx

```sh
npx midplane --version
npx midplane local --config midplane.yaml     # local mode
npx midplane gateway --config midplane.yaml   # linked to Midplane Cloud
```

Or install it once: `npm install --global midplane`. The package is the
`midplane` command; it has no library API.

## The container image

```sh
docker pull ghcr.io/midplaneai/midplane:0.21.0
```

- Built from the same npm tarball, on `node:24-slim`, for `linux/amd64` and
  `linux/arm64`.
- Runs as the non-root `node` user. Its entrypoint is `midplane`, and its
  default command is `gateway --config /etc/midplane/midplane.yaml`.
- Its working directory, `/var/lib/midplane`, belongs to that user: put the
  audit file, the bundle cache and the identity file there, on a volume, with
  relative paths in the config or absolute ones under it.

```sh
docker run -d --name midplane \
  -v ./midplane.yaml:/etc/midplane/midplane.yaml:ro \
  -v midplane-data:/var/lib/midplane \
  -e DSN_MAIN -e MIDPLANE_MASK_SALT \
  -p 7433:7433 \
  ghcr.io/midplaneai/midplane:0.21.0
```

**TLS off loopback.** The gateway refuses to listen on anything but loopback
without TLS, so agents' tokens never cross a network in the clear. In a
container listening on `0.0.0.0`, set `tls.cert_file` and `tls.key_file`
(mounted from a secret) and `public_urls`, or run a TLS-terminating proxy or
tunnel in the same network namespace and keep the gateway on `127.0.0.1`
([hosted agents](hosted-agents.md) has examples).

## Verifying what you installed

Each release is published with npm provenance, and its image is signed with
Sigstore and carries an SBOM: [verifying a release](releases.md).

*Tested by* CI's `package` job (`apps/gateway/scripts/package-smoke.ts`):
it installs the packed tarball with npm and runs local and linked mode, and
runs the image built from it as a non-root user.
