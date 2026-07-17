# Sample database image — plain Postgres 16 for a small always-on Fly Machine.
#
# Why a DIY image and not Fly Managed Postgres / Supabase / Neon: the sample DB
# is <1 MB of read-only, re-seedable synthetic data whose whole job is a fast
# first impression. A DIY Machine is ~$2-3/mo always-on (vs ~$25-38 for any
# no-cold-start managed tier), gives full superuser so provision.sql's role
# guardrails apply verbatim, and colocates with midplane-web in one Fly org.
# See README.md "Hosting" for the full comparison.
#
# Self-seeds on FIRST boot only: the postgres image runs everything in
# /docker-entrypoint-initdb.d exactly once, when PGDATA is empty. So the first
# time the machine comes up on a fresh volume, provision.sql + seed.sql run
# automatically. Later deploys skip init (non-empty PGDATA) — re-seed is manual,
# see README.md "Re-seeding".
FROM postgres:16

# Self-signed cert so `sslmode=require` works end-to-end. `require` encrypts but
# does NOT verify the cert, so self-signed is sufficient — and the DSN is public
# by design, so there is no secret a "real" CA would protect anyway.
RUN set -eux; \
    mkdir -p /etc/postgresql-ssl; \
    openssl req -new -x509 -days 3650 -nodes -text \
      -subj "/CN=midplane-sample-db" \
      -out /etc/postgresql-ssl/server.crt \
      -keyout /etc/postgresql-ssl/server.key; \
    chmod 600 /etc/postgresql-ssl/server.key; \
    chown -R postgres:postgres /etc/postgresql-ssl

# provision.sql + seed.sql stay the single source of truth; initdb.sh runs them
# on first boot with SAMPLE_PASSWORD (a Fly secret) read from the environment.
COPY provision.sql seed.sql /opt/sample-db/
COPY initdb.sh /docker-entrypoint-initdb.d/10-provision-seed.sh
RUN chmod +x /docker-entrypoint-initdb.d/10-provision-seed.sh

# ssl on (for sslmode=require) + modest tuning to sit comfortably in 256 MB.
# max_connections 25 leaves headroom above the role's CONNECTION LIMIT 20.
CMD ["postgres", \
  "-c", "ssl=on", \
  "-c", "ssl_cert_file=/etc/postgresql-ssl/server.crt", \
  "-c", "ssl_key_file=/etc/postgresql-ssl/server.key", \
  "-c", "max_connections=25", \
  "-c", "shared_buffers=64MB", \
  "-c", "work_mem=8MB"]
