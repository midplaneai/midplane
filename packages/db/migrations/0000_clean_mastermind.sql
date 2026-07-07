-- =============================================================================
-- SQUASHED BASELINE — connection→project rename (pre-launch, Approach C).
--
-- This SINGLE migration REPLACES the original migrations 0000-0028 and applies
-- ONLY to a FRESH database. Any database that already ran 0000-0028 (a deployed
-- Fly Postgres, a dev branch) MUST be DROPPED and recreated before deploying
-- this — otherwise Drizzle tries to apply this baseline against existing tables
-- and the deploy fails. The DO-block guard below turns that into an explicit,
-- actionable error instead of a cryptic "relation already exists".
--
-- DEPLOY STEP (pre-launch, authorized): reset every target database before the
-- first migrate against this baseline.
--
-- Built by pg_dump of the fully-migrated schema with a connection->project
-- substitution; equivalence-validated against the old history. RLS policies and
-- CHECK constraints are preserved verbatim below.
-- =============================================================================

--
-- PostgreSQL database dump
--


-- Dumped from database version 14.23 (Debian 14.23-1.pgdg13+1)
-- Dumped by pg_dump version 14.23 (Debian 14.23-1.pgdg13+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
-- pg_dump emits `set_config('search_path', '', false)` here so its own dump body
-- can use fully schema-qualified names. But `false` (is_local=false) makes it a
-- SESSION setting, and Drizzle's migrator runs every pending migration in ONE
-- session: an empty search_path then breaks later migrations that reference
-- unqualified names (e.g. 0001's `ALTER TABLE "project_databases"`), rolling the
-- whole batch back on a fresh DB. All baseline objects below are `public.*`
-- qualified, so pinning the path to `public` is safe here and keeps unqualified
-- names in subsequent migrations resolving. Do NOT restore the empty value.
SELECT pg_catalog.set_config('search_path', 'public', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- Guard: refuse to apply the squash baseline onto a database that still carries
-- the pre-rename schema (see header). A FRESH database has no public.connections
-- table, so it passes straight through to the CREATEs below.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'connections'
  ) THEN
    RAISE EXCEPTION 'connection->project squash baseline cannot apply: this database still has the pre-rename schema (table public.connections). This baseline replaces migrations 0000-0028 and only runs on a FRESH database — DROP and recreate the database before deploying. See migrations/0000_clean_mastermind.sql header.';
  END IF;
END $$;

--
-- Name: enforce_customer_region_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_customer_region_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.region IS DISTINCT FROM NEW.region THEN
    RAISE EXCEPTION 'customer.region is immutable in V1 (cross-region migration is V2)';
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account (
    id text NOT NULL,
    user_id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    access_token text,
    refresh_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    id_token text,
    password text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_events_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events_index (
    id text NOT NULL,
    customer_id text NOT NULL,
    tenant_id text NOT NULL,
    region text NOT NULL,
    query_id text NOT NULL,
    agent_identity text,
    ts timestamp with time zone NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    schema_version integer DEFAULT 1 NOT NULL,
    database text DEFAULT 'main'::text NOT NULL,
    agent_name text,
    agent_version text,
    agent_intent text,
    intent_source text,
    actor_user_id text,
    mcp_token_id text,
    project_id text,
    CONSTRAINT audit_events_index_agent_intent_len_check CHECK (((agent_intent IS NULL) OR (char_length(agent_intent) <= 500))),
    CONSTRAINT audit_events_index_intent_source_check CHECK (((intent_source IS NULL) OR (intent_source = ANY (ARRAY['mcp_meta'::text, 'sql_comment'::text, 'http_header'::text]))))
);

ALTER TABLE ONLY public.audit_events_index FORCE ROW LEVEL SECURITY;


--
-- Name: project_databases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_databases (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    encrypted_dsn bytea NOT NULL,
    kms_key_id text NOT NULL,
    table_access jsonb DEFAULT '{"tables": {}, "default": "deny"}'::jsonb NOT NULL,
    tenant_scope_mappings jsonb DEFAULT '{"column": null, "exempt": [], "overrides": {}}'::jsonb NOT NULL,
    rotated_at timestamp with time zone,
    last_kms_success_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    guardrails jsonb DEFAULT '{"block_ddl": true, "block_unqualified_dml": true}'::jsonb NOT NULL,
    CONSTRAINT project_databases_guardrails_shape_chk CHECK (((guardrails ?& ARRAY['block_unqualified_dml'::text, 'block_ddl'::text]) AND (jsonb_typeof((guardrails -> 'block_unqualified_dml'::text)) = 'boolean'::text) AND (jsonb_typeof((guardrails -> 'block_ddl'::text)) = 'boolean'::text))),
    CONSTRAINT project_databases_tenant_scope_shape_chk CHECK (((jsonb_typeof((tenant_scope_mappings -> 'column'::text)) = ANY (ARRAY['null'::text, 'string'::text])) AND (jsonb_typeof((tenant_scope_mappings -> 'overrides'::text)) = 'object'::text) AND (jsonb_typeof((tenant_scope_mappings -> 'exempt'::text)) = 'array'::text)))
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id text NOT NULL,
    customer_id text NOT NULL,
    region text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    paused_at timestamp with time zone
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id text NOT NULL,
    org_id text NOT NULL,
    email text NOT NULL,
    region text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    plan_override text,
    owner_email text,
    plan text DEFAULT 'free'::text NOT NULL
);


--
-- Name: indexer_cursors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.indexer_cursors (
    region text NOT NULL,
    last_id text DEFAULT ''::text NOT NULL,
    last_indexed_at timestamp with time zone,
    last_error_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    customer_id text NOT NULL,
    id text NOT NULL,
    project_id text
);


--
-- Name: invitation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invitation (
    id text NOT NULL,
    email text NOT NULL,
    inviter_id text NOT NULL,
    organization_id text NOT NULL,
    role text,
    status text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_scope_grants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_scope_grants (
    id text NOT NULL,
    project_database_id text NOT NULL,
    client_id text,
    user_id text,
    mcp_token_id text,
    access text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_scope_grants_access_check CHECK ((access = ANY (ARRAY['read'::text, 'write'::text]))),
    CONSTRAINT mcp_scope_grants_subject_check CHECK ((((client_id IS NOT NULL) AND (user_id IS NOT NULL) AND (mcp_token_id IS NULL)) OR ((client_id IS NULL) AND (user_id IS NULL) AND (mcp_token_id IS NOT NULL))))
);


--
-- Name: mcp_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_tokens (
    id text NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    prefix text NOT NULL,
    last4 text NOT NULL,
    token_hash bytea,
    pepper_kid text,
    created_by_user_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    last_used_ip inet,
    last_used_ua text,
    status text DEFAULT 'active'::text NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    kind text DEFAULT 'url'::text NOT NULL,
    client_id text,
    CONSTRAINT mcp_tokens_kind_check CHECK ((kind = ANY (ARRAY['url'::text, 'oauth'::text]))),
    CONSTRAINT mcp_tokens_status_check CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'expired'::text])))
);


--
-- Name: member; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.member (
    id text NOT NULL,
    user_id text NOT NULL,
    organization_id text NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_access_token; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_access_token (
    id text NOT NULL,
    access_token text NOT NULL,
    refresh_token text NOT NULL,
    access_token_expires_at timestamp with time zone NOT NULL,
    refresh_token_expires_at timestamp with time zone NOT NULL,
    client_id text NOT NULL,
    user_id text,
    scopes text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_application; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_application (
    id text NOT NULL,
    name text,
    icon text,
    metadata text,
    client_id text NOT NULL,
    client_secret text,
    redirect_urls text NOT NULL,
    type text NOT NULL,
    disabled boolean DEFAULT false NOT NULL,
    user_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_consent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_consent (
    id text NOT NULL,
    client_id text NOT NULL,
    user_id text NOT NULL,
    scopes text NOT NULL,
    consent_given boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: organization; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organization (
    id text NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    metadata text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_customer_id text
);


--
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    id text NOT NULL,
    user_id text NOT NULL,
    token text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    active_organization_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sso_provider; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sso_provider (
    id text NOT NULL,
    issuer text NOT NULL,
    domain text NOT NULL,
    oidc_config text,
    saml_config text,
    user_id text NOT NULL,
    provider_id text NOT NULL,
    organization_id text,
    domain_verified boolean,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription (
    id text NOT NULL,
    plan text NOT NULL,
    reference_id text NOT NULL,
    stripe_customer_id text,
    stripe_subscription_id text,
    status text DEFAULT 'incomplete'::text NOT NULL,
    period_start timestamp with time zone,
    period_end timestamp with time zone,
    trial_start timestamp with time zone,
    trial_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false,
    cancel_at timestamp with time zone,
    canceled_at timestamp with time zone,
    ended_at timestamp with time zone,
    seats integer,
    billing_interval text,
    stripe_schedule_id text
);


--
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    stripe_customer_id text
);


--
-- Name: verification; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: audit_events_index audit_events_index_event_type_check; Type: CHECK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE public.audit_events_index
    ADD CONSTRAINT audit_events_index_event_type_check CHECK ((event_type = ANY (ARRAY['ATTEMPTED'::text, 'DECIDED'::text, 'EXECUTED'::text, 'FAILED'::text, 'POLICY_RELOADED'::text, 'POLICY_CHANGED'::text, 'TENANT_SCOPE_CHANGED'::text, 'GUARDRAILS_CHANGED'::text, 'REGION_CHANGED'::text, 'TOKEN_CREATED'::text, 'TOKEN_REVOKED'::text, 'PROJECT_PAUSED'::text, 'PROJECT_RESUMED'::text]))) NOT VALID;


--
-- Name: audit_events_index audit_events_index_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events_index
    ADD CONSTRAINT audit_events_index_pkey PRIMARY KEY (id);


--
-- Name: project_databases project_databases_project_name_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_databases
    ADD CONSTRAINT project_databases_project_name_uq UNIQUE (project_id, name);


--
-- Name: project_databases project_databases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_databases
    ADD CONSTRAINT project_databases_pkey PRIMARY KEY (id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: customers customers_id_region_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_id_region_uq UNIQUE (id, region);


--
-- Name: customers customers_org_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_org_id_unique UNIQUE (org_id);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: indexer_cursors indexer_cursors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexer_cursors
    ADD CONSTRAINT indexer_cursors_pkey PRIMARY KEY (id);


--
-- Name: invitation invitation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT invitation_pkey PRIMARY KEY (id);


--
-- Name: mcp_scope_grants mcp_scope_grants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_scope_grants
    ADD CONSTRAINT mcp_scope_grants_pkey PRIMARY KEY (id);


--
-- Name: mcp_tokens mcp_tokens_name_per_project_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_name_per_project_uq UNIQUE (project_id, name);


--
-- Name: mcp_tokens mcp_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_pkey PRIMARY KEY (id);


--
-- Name: mcp_tokens mcp_tokens_token_hash_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_token_hash_uq UNIQUE (token_hash);


--
-- Name: member member_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (id);


--
-- Name: oauth_access_token oauth_access_token_access_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_access_token_unique UNIQUE (access_token);


--
-- Name: oauth_access_token oauth_access_token_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_pkey PRIMARY KEY (id);


--
-- Name: oauth_access_token oauth_access_token_refresh_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_refresh_token_unique UNIQUE (refresh_token);


--
-- Name: oauth_application oauth_application_client_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_application
    ADD CONSTRAINT oauth_application_client_id_unique UNIQUE (client_id);


--
-- Name: oauth_application oauth_application_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_application
    ADD CONSTRAINT oauth_application_pkey PRIMARY KEY (id);


--
-- Name: oauth_consent oauth_consent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_consent
    ADD CONSTRAINT oauth_consent_pkey PRIMARY KEY (id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organization
    ADD CONSTRAINT organization_slug_unique UNIQUE (slug);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_token_unique UNIQUE (token);


--
-- Name: sso_provider sso_provider_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_provider
    ADD CONSTRAINT sso_provider_pkey PRIMARY KEY (id);


--
-- Name: sso_provider sso_provider_provider_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_provider
    ADD CONSTRAINT sso_provider_provider_id_unique UNIQUE (provider_id);


--
-- Name: subscription subscription_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription
    ADD CONSTRAINT subscription_pkey PRIMARY KEY (id);


--
-- Name: user user_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_email_unique UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: audit_attempted_fingerprint_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_attempted_fingerprint_idx ON public.audit_events_index USING btree (((payload ->> 'sql_fingerprint'::text))) WHERE (event_type = 'ATTEMPTED'::text);


--
-- Name: audit_customer_region_agent_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_customer_region_agent_ts_idx ON public.audit_events_index USING btree (customer_id, region, agent_name, ts DESC) WHERE (agent_name IS NOT NULL);


--
-- Name: audit_customer_region_project_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_customer_region_project_ts_idx ON public.audit_events_index USING btree (customer_id, region, project_id, ts DESC) WHERE (project_id IS NOT NULL);


--
-- Name: audit_customer_region_database_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_customer_region_database_ts_idx ON public.audit_events_index USING btree (customer_id, region, database, ts DESC);


--
-- Name: audit_customer_region_token_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_customer_region_token_ts_idx ON public.audit_events_index USING btree (customer_id, region, mcp_token_id, ts DESC) WHERE (mcp_token_id IS NOT NULL);


--
-- Name: audit_customer_region_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_customer_region_ts_idx ON public.audit_events_index USING btree (customer_id, region, ts DESC NULLS LAST);


--
-- Name: audit_customer_region_type_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_customer_region_type_ts_idx ON public.audit_events_index USING btree (customer_id, region, event_type, ts DESC NULLS LAST);


--
-- Name: audit_query_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_query_id_idx ON public.audit_events_index USING btree (query_id);


--
-- Name: project_databases_project_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX project_databases_project_id_idx ON public.project_databases USING btree (project_id);


--
-- Name: projects_customer_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX projects_customer_id_idx ON public.projects USING btree (customer_id);


--
-- Name: indexer_cursors_project_id_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX indexer_cursors_project_id_uq ON public.indexer_cursors USING btree (project_id) WHERE (project_id IS NOT NULL);


--
-- Name: indexer_cursors_customer_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexer_cursors_customer_id_idx ON public.indexer_cursors USING btree (customer_id);


--
-- Name: indexer_cursors_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX indexer_cursors_region_idx ON public.indexer_cursors USING btree (region);


--
-- Name: mcp_scope_grants_cdb_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_scope_grants_cdb_idx ON public.mcp_scope_grants USING btree (project_database_id);


--
-- Name: mcp_scope_grants_oauth_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_scope_grants_oauth_uq ON public.mcp_scope_grants USING btree (client_id, user_id, project_database_id) WHERE (mcp_token_id IS NULL);


--
-- Name: mcp_scope_grants_pat_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_scope_grants_pat_uq ON public.mcp_scope_grants USING btree (mcp_token_id, project_database_id) WHERE (mcp_token_id IS NOT NULL);


--
-- Name: mcp_tokens_project_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tokens_project_status_idx ON public.mcp_tokens USING btree (project_id, status);


--
-- Name: mcp_tokens_expires_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mcp_tokens_expires_at_idx ON public.mcp_tokens USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (status = 'active'::text));


--
-- Name: mcp_tokens_oauth_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX mcp_tokens_oauth_client_idx ON public.mcp_tokens USING btree (project_id, client_id) WHERE (kind = 'oauth'::text);


--
-- Name: oauth_access_token_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_access_token_client_id_idx ON public.oauth_access_token USING btree (client_id);


--
-- Name: oauth_access_token_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_access_token_user_id_idx ON public.oauth_access_token USING btree (user_id);


--
-- Name: oauth_application_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_application_user_id_idx ON public.oauth_application USING btree (user_id);


--
-- Name: oauth_consent_client_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_consent_client_id_idx ON public.oauth_consent USING btree (client_id);


--
-- Name: oauth_consent_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX oauth_consent_user_id_idx ON public.oauth_consent USING btree (user_id);


--
-- Name: sso_provider_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sso_provider_domain_idx ON public.sso_provider USING btree (domain);


--
-- Name: sso_provider_organization_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sso_provider_organization_id_idx ON public.sso_provider USING btree (organization_id);


--
-- Name: subscription_reference_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscription_reference_id_idx ON public.subscription USING btree (reference_id);


--
-- Name: subscription_stripe_subscription_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscription_stripe_subscription_id_idx ON public.subscription USING btree (stripe_subscription_id);


--
-- Name: customers customers_region_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER customers_region_immutable BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.enforce_customer_region_immutable();


--
-- Name: account account_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account
    ADD CONSTRAINT account_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: audit_events_index audit_events_index_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events_index
    ADD CONSTRAINT audit_events_index_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: audit_events_index audit_events_index_mcp_token_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events_index
    ADD CONSTRAINT audit_events_index_mcp_token_id_fk FOREIGN KEY (mcp_token_id) REFERENCES public.mcp_tokens(id) ON DELETE SET NULL;


--
-- Name: project_databases project_databases_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_databases
    ADD CONSTRAINT project_databases_project_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: projects projects_customer_region_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_customer_region_fk FOREIGN KEY (customer_id, region) REFERENCES public.customers(id, region);


--
-- Name: indexer_cursors indexer_cursors_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.indexer_cursors
    ADD CONSTRAINT indexer_cursors_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: invitation invitation_inviter_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT invitation_inviter_id_user_id_fk FOREIGN KEY (inviter_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: invitation invitation_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invitation
    ADD CONSTRAINT invitation_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: mcp_scope_grants mcp_scope_grants_client_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_scope_grants
    ADD CONSTRAINT mcp_scope_grants_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_application(client_id) ON DELETE CASCADE;


--
-- Name: mcp_scope_grants mcp_scope_grants_project_database_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_scope_grants
    ADD CONSTRAINT mcp_scope_grants_project_database_fk FOREIGN KEY (project_database_id) REFERENCES public.project_databases(id) ON DELETE CASCADE;


--
-- Name: mcp_scope_grants mcp_scope_grants_mcp_token_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_scope_grants
    ADD CONSTRAINT mcp_scope_grants_mcp_token_id_fk FOREIGN KEY (mcp_token_id) REFERENCES public.mcp_tokens(id) ON DELETE CASCADE;


--
-- Name: mcp_scope_grants mcp_scope_grants_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_scope_grants
    ADD CONSTRAINT mcp_scope_grants_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: mcp_tokens mcp_tokens_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_tokens
    ADD CONSTRAINT mcp_tokens_project_fk FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: member member_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: member member_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.member
    ADD CONSTRAINT member_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauth_access_token oauth_access_token_client_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_application(client_id) ON DELETE CASCADE;


--
-- Name: oauth_access_token oauth_access_token_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_access_token
    ADD CONSTRAINT oauth_access_token_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauth_application oauth_application_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_application
    ADD CONSTRAINT oauth_application_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: oauth_consent oauth_consent_client_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_consent
    ADD CONSTRAINT oauth_consent_client_id_fk FOREIGN KEY (client_id) REFERENCES public.oauth_application(client_id) ON DELETE CASCADE;


--
-- Name: oauth_consent oauth_consent_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_consent
    ADD CONSTRAINT oauth_consent_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: session session_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: sso_provider sso_provider_organization_id_organization_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_provider
    ADD CONSTRAINT sso_provider_organization_id_organization_id_fk FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;


--
-- Name: sso_provider sso_provider_user_id_user_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sso_provider
    ADD CONSTRAINT sso_provider_user_id_user_id_fk FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;


--
-- Name: audit_events_index; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_events_index ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_events_index audit_events_index_tenant_isolation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY audit_events_index_tenant_isolation ON public.audit_events_index USING ((customer_id = current_setting('app.customer_id'::text, true)));


--
-- PostgreSQL database dump complete
--


