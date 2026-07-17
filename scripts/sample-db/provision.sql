-- Sample database — role hardening (support-onboarding Day 2, item 8).
--
-- The sample DSN ships in the dashboard, so treat the credential as PUBLIC.
-- Everything here caps what a hostile holder of that DSN can do to the
-- shared host; the Midplane engine's policy layer is the demo, not the
-- defense. Layers, all from the design doc:
--
--   ENFORCED (a hostile client cannot undo these):
--   - LOGIN + CONNECTION LIMIT 20  — a runaway evaluator (or abuser) can't
--     exhaust the host's connection slots. Raise deliberately if real
--     traffic hits the cap; the app-side symptom is "too many connections"
--     on Test connection.
--   - REVOKE CREATE/TEMP           — no DDL, no temp-table scratch space
--     (on the maintenance DBs too — see below).
--   - GRANT SELECT only            — writes are impossible at the DB layer
--     (seed.sql owns the per-table grants; they're re-applied on re-seed).
--
--   HYGIENE ONLY (session defaults — all three are USERSET GUCs any
--   connected client can override with a plain SET, so they bound honest
--   traffic, not attacks; the enforcement layer is the two items above and
--   the blast radius is demo-box availability, never data):
--   - statement_timeout 2s          — no accidental long scans.
--   - idle_in_transaction 10s       — no accidental slot camping.
--   - default_transaction_read_only — belt; the real guard is grants.
--
-- Run ONCE as an admin role, connected to the sample database (named
-- `sample`, so the dashboard form derives the agent-facing alias "sample"
-- from the DSN):
--
--   createdb sample   # or the host's equivalent
--   psql "$ADMIN_SAMPLE_DSN" -v sample_password="$SAMPLE_PASSWORD" -f provision.sql
--   psql "$ADMIN_SAMPLE_DSN" -f seed.sql
--
-- Re-running: the role already exists — rotate its password instead with
--   ALTER ROLE midplane_sample PASSWORD '<new>';

\set ON_ERROR_STOP on

CREATE ROLE midplane_sample LOGIN PASSWORD :'sample_password' CONNECTION LIMIT 20;

ALTER ROLE midplane_sample SET statement_timeout = '2s';
ALTER ROLE midplane_sample SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE midplane_sample SET default_transaction_read_only = on;

REVOKE ALL ON DATABASE sample FROM PUBLIC;
GRANT CONNECT ON DATABASE sample TO midplane_sample;
REVOKE CREATE, TEMP ON DATABASE sample FROM midplane_sample;

-- The maintenance databases keep PUBLIC's default CONNECT + TEMP unless
-- revoked — without this, the public credential can slip into postgres/
-- template1 and use temp tables there to fill the volume. template0 already
-- refuses connections.
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;

-- Large objects are the one WRITE path table grants don't cover — the lo_*
-- write functions are PUBLIC-executable by default, so a hostile DSN holder
-- could fill the volume with lo_from_bytea despite SELECT-only grants.
-- Unlike the GUCs above, EXECUTE grants are enforcement-grade (no client-side
-- SET undoes them). Superuser/admin keeps access (grants don't bind it).
REVOKE EXECUTE ON FUNCTION
  lo_create(oid),
  lo_creat(integer),
  lo_from_bytea(oid, bytea),
  lo_import(text),
  lo_import(text, oid),
  lo_open(oid, integer),
  lowrite(integer, bytea),
  lo_put(oid, bigint, bytea)
FROM PUBLIC;

-- Schema-level: usage yes, create no (PG15+ already denies PUBLIC create on
-- public; the explicit revoke covers older hosts).
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO midplane_sample;
