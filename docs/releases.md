# Verifying a release

A release is a tag `vX.Y.Z` on `main` in `midplaneai/midplane`. Its workflow
(`.github/workflows/release.yml`) runs CI, then packs the gateway once with
its whole dependency tree pinned in `npm-shrinkwrap.json`, runs the package
smoke test on that tarball and an image built from it, and only then, in a
separate job that runs none of its code or dependencies on the runner,
publishes that same tarball:

- the npm package `midplane`, with provenance: a Sigstore-signed statement
  that this tarball was built by that workflow, from that commit, in this
  public repository;
- the image `ghcr.io/midplaneai/midplane:X.Y.Z` (amd64 and arm64), with an
  SBOM and build provenance attached, signed keyless with cosign by the same
  workflow's identity. `:latest` moves to each release; deploy a version tag
  or, better, the digest.

Versions stay below 1.0 until the gateway has been used and tested more
widely; v0.21.0 is the first of this gateway (earlier `midplane` versions on
npm are an older, unrelated engine).

## The npm package

In a project that installed it:

```sh
npm audit signatures
```

checks the registry's signature on every installed package and the
provenance attestations of those that have one; `midplane` should be listed
as verified with provenance. The package's page on npmjs.com links its
provenance to the workflow run and the commit.

## The image

```sh
cosign verify ghcr.io/midplaneai/midplane:0.21.0 \
  --certificate-identity-regexp '^https://github\.com/midplaneai/midplane/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

passes only for an image signed by that workflow, on a tag, in that
repository. Pin the digest it prints when you deploy.

The SBOM (SPDX) and the build provenance are attestations on the image:

```sh
docker buildx imagetools inspect ghcr.io/midplaneai/midplane:0.21.0 --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/midplaneai/midplane:0.21.0 --format '{{ json .Provenance }}'
```

## What is tested before a release

Every change runs the package job in CI: the packed tarball is installed with
npm and runs the local quickstart, `midplane enroll` and linked mode, and the
image built from it runs the quickstart as a non-root user. A release runs the
same test on the exact tarball it publishes. Installing it runs no dependency
install scripts (`--ignore-scripts`), in the test and in the image. Publishing,
signing and the attestations happen only on a tag; the commands above are how
to check what a tag produced.
