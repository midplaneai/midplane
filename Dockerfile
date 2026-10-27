# The gateway's image: the npm package, installed on Node 24 and run as the
# non-root `node` user. It is built from the packed tarball, as the release
# workflow builds it, so the image and `npx midplane` run the same code.
#
#   node apps/gateway/scripts/build.ts
#   (cd apps/gateway && pnpm pack --pack-destination ../../image)
#   docker build --build-arg TARBALL=image/midplane-0.23.0.tgz -t midplane .
#
# The default command, `midplane start`, serves the config mounted at
# /etc/midplane/midplane.yaml; else the one in the working directory,
# /var/lib/midplane, which is the user's, on a volume; else, with
# MIDPLANE_ENROLLMENT_TOKEN and the rest of the setup in the environment
# (`docker run --env-file`), it sets the gateway up in that directory first.
# Keep the audit file, the bundle cache and the identity there. The gateway
# listens on 7433; with `tls.acme` it answers the certificate's challenge on
# 7480, which the server's port 80 forwards to (`-p 80:7480`).

# node:24-slim, pinned by digest (the gateway needs Node 24.16+).
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# The source label links the image to its repository on GHCR.
LABEL org.opencontainers.image.source="https://github.com/midplaneai/midplane" \
  org.opencontainers.image.description="A gateway between AI agents and your Postgres databases" \
  org.opencontainers.image.licenses="MIT"

ARG TARBALL
COPY ${TARBALL} /tmp/midplane.tgz
# The tarball's npm-shrinkwrap.json pins every dependency to what the
# release tested; none of them gets to run an install script.
RUN npm install --global --ignore-scripts --no-audit --no-fund /tmp/midplane.tgz \
  && rm /tmp/midplane.tgz \
  && npm cache clean --force \
  && mkdir -p /var/lib/midplane /etc/midplane \
  && chown node:node /var/lib/midplane

USER node
WORKDIR /var/lib/midplane
EXPOSE 7433
ENTRYPOINT ["midplane"]
CMD ["start"]
