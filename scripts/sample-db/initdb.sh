#!/usr/bin/env bash
# First-boot provisioning for the sample database. The postgres image runs this
# once, via /docker-entrypoint-initdb.d, while the server is up on the local
# socket but not yet accepting external connections.
#
# provision.sql needs SAMPLE_PASSWORD (the read-only midplane_sample role's
# password); it is supplied as a Fly secret and read from the environment here.
# POSTGRES_DB=sample means the `sample` database already exists at this point.
set -euo pipefail

: "${SAMPLE_PASSWORD:?SAMPLE_PASSWORD must be set (fly secret) — the read-only role password}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname sample \
  -v sample_password="$SAMPLE_PASSWORD" \
  -f /opt/sample-db/provision.sql

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname sample \
  -f /opt/sample-db/seed.sql
