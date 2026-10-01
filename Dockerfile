# The gateway's image: the npm package, installed on Node 24 and run as the
# non-root `node` user. It is built from the packed tarball, as the release
# workflow builds it, so the image and `npx midplane` run the same code.
#
#   node apps/gateway/scripts/build.ts
#   (cd apps/gateway && pnpm pack --pack-destination ../../image)
#   docker build --build-arg TARBALL=image/midplane-0.21.0.tgz -t midplane .
#
# Mount the config at /etc/midplane/midplane.yaml. The working directory,
# /var/lib/midplane, is the user's: keep the audit file, the bundle cache
# and the identity there, on a volume.

# node:24-slim, pinned by digest; Node 24.19 (the gateway needs 24.16+).
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

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
CMD ["gateway", "--config", "/etc/midplane/midplane.yaml"]
