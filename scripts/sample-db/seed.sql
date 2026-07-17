-- Sample database — schema + data (support-onboarding Day 2, item 8).
--
-- A compact mock-SaaS dataset (customers → subscriptions → invoices →
-- support_tickets) for evaluators without a reachable Postgres of their own.
-- Chosen over Pagila because it demos Midplane's point: customers carries
-- obvious PII columns (email, phone) the exposure scan lights up, and the
-- money tables answer the demo prompts ("monthly revenue by plan?", "top
-- customers by lifetime invoice total?") any agent will reach for.
--
-- Deterministic: every value is arithmetic on the row index — no random(),
-- so re-seeding produces byte-identical data. All values are synthetic;
-- emails end in @example.com (RFC 2606).
--
-- Run as the ADMIN role, connected to the sample database, AFTER
-- provision.sql (which creates the read-only midplane_sample role):
--
--   psql "$ADMIN_SAMPLE_DSN" -f seed.sql
--
-- Idempotent: drops + recreates the tables, then re-grants SELECT (grants
-- die with the dropped tables, so they live here, not in provision.sql).

\set ON_ERROR_STOP on

BEGIN;

DROP TABLE IF EXISTS support_tickets, invoices, subscriptions, customers CASCADE;

CREATE TABLE customers (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text        NOT NULL,
  email         text        NOT NULL UNIQUE,
  phone         text        NOT NULL,
  country       text        NOT NULL,
  signed_up_at  timestamptz NOT NULL
);

CREATE TABLE subscriptions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   bigint      NOT NULL REFERENCES customers (id),
  plan          text        NOT NULL CHECK (plan IN ('free', 'pro', 'team')),
  status        text        NOT NULL CHECK (status IN ('active', 'canceled')),
  mrr_cents     integer     NOT NULL,
  started_at    timestamptz NOT NULL,
  canceled_at   timestamptz
);

CREATE TABLE invoices (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   bigint      NOT NULL REFERENCES customers (id),
  amount_cents  integer     NOT NULL,
  status        text        NOT NULL CHECK (status IN ('paid', 'open', 'void')),
  issued_at     timestamptz NOT NULL,
  paid_at       timestamptz
);

CREATE TABLE support_tickets (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id   bigint      NOT NULL REFERENCES customers (id),
  subject       text        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at     timestamptz NOT NULL,
  closed_at     timestamptz
);

-- 200 customers, signed up over ~2 years ending 2026-06-30.
INSERT INTO customers (name, email, phone, country, signed_up_at)
SELECT
  n.first_names[1 + (i * 7) % 24] || ' ' || n.last_names[1 + (i * 13) % 24],
  lower(
    n.first_names[1 + (i * 7) % 24] || '.' ||
    n.last_names[1 + (i * 13) % 24] || i::text || '@example.com'
  ),
  '+1-' || lpad((100 + (i * 7919) % 900)::text, 3, '0')
        || '-555-'
        || lpad(((i * 104729) % 10000)::text, 4, '0'),
  (ARRAY['US','DE','GB','FR','NL','CA','AU','SE'])[1 + (i * 3) % 8],
  timestamptz '2024-07-01 00:00:00+00'
    + ((i * 89) % 730) * interval '1 day'
    + ((i * 37) % 24)  * interval '1 hour'
FROM generate_series(1, 200) AS i,
     (SELECT
        ARRAY['Ada','Grace','Alan','Edsger','Barbara','Donald','Radia','Ken',
              'Dennis','Margaret','Linus','Guido','Anders','Bjarne','John',
              'Frances','Katherine','Tim','Vint','Leslie','Niklaus','Brian',
              'Adele','Hedy'] AS first_names,
        ARRAY['Lovelace','Hopper','Turing','Dijkstra','Liskov','Knuth',
              'Perlman','Thompson','Ritchie','Hamilton','Torvalds','Rossum',
              'Hejlsberg','Stroustrup','Backus','Allen','Johnson',
              'Berners-Lee','Cerf','Lamport','Wirth','Kernighan','Goldberg',
              'Lamarr'] AS last_names
     ) AS n;

-- One subscription per customer. Plan mix ~ free-heavy; every 9th is
-- canceled (canceled subs keep their plan but bill 0 going forward).
INSERT INTO subscriptions (customer_id, plan, status, mrr_cents, started_at, canceled_at)
SELECT
  c.id,
  p.plan,
  CASE WHEN c.id % 9 = 0 THEN 'canceled' ELSE 'active' END,
  CASE p.plan WHEN 'free' THEN 0 WHEN 'pro' THEN 4900 ELSE 19900 END,
  c.signed_up_at + interval '2 hours',
  CASE WHEN c.id % 9 = 0
       THEN c.signed_up_at + (30 + (c.id * 11) % 240) * interval '1 day'
  END
FROM customers c,
     LATERAL (
       SELECT (ARRAY['free','free','free','pro','pro','team'])[1 + (c.id * 5) % 6] AS plan
     ) AS p;

-- Monthly invoices for paying subscriptions, from start until cancellation
-- (or the seed horizon). Most are paid within 3 days; every 11th is open,
-- every 47th void.
INSERT INTO invoices (customer_id, amount_cents, status, issued_at, paid_at)
SELECT
  s.customer_id,
  s.mrr_cents,
  st.status,
  m.issued_at,
  CASE WHEN st.status = 'paid' THEN m.issued_at + interval '3 days' END
FROM subscriptions s
CROSS JOIN LATERAL (
  SELECT s.started_at + gs * interval '1 month' AS issued_at, gs
  FROM generate_series(0, 23) AS gs
) AS m
CROSS JOIN LATERAL (
  SELECT CASE
    WHEN (s.customer_id + m.gs) % 47 = 0 THEN 'void'
    WHEN (s.customer_id + m.gs) % 11 = 0 THEN 'open'
    ELSE 'paid'
  END AS status
) AS st
WHERE s.mrr_cents > 0
  AND m.issued_at < timestamptz '2026-07-01 00:00:00+00'
  AND (s.canceled_at IS NULL OR m.issued_at < s.canceled_at);

-- A support ticket for every third customer; ~two-thirds closed.
INSERT INTO support_tickets (customer_id, subject, status, opened_at, closed_at)
SELECT
  c.id,
  (ARRAY[
    'Cannot connect my agent',
    'Question about per-table permissions',
    'Invoice does not match my plan',
    'How do I rotate my connection string?',
    'Audit log export request',
    'Masking a legacy email column',
    'Upgrade from pro to team',
    'Read replica support?'
  ])[1 + (c.id * 17) % 8],
  CASE WHEN c.id % 3 = 1 THEN 'open' ELSE 'closed' END,
  c.signed_up_at + ((c.id * 23) % 200) * interval '1 day',
  CASE WHEN c.id % 3 <> 1
       THEN c.signed_up_at + ((c.id * 23) % 200) * interval '1 day'
            + (4 + (c.id * 5) % 72) * interval '1 hour'
  END
FROM customers c
WHERE c.id % 3 = 0 OR c.id % 3 = 1;

-- Grants die with DROP TABLE, so re-grant on every seed. The role itself
-- (login, connection limit, timeouts, read-only default) is provision.sql's
-- job and survives re-seeding.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO midplane_sample;

COMMIT;

ANALYZE customers, subscriptions, invoices, support_tickets;
