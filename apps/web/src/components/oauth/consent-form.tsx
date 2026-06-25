"use client";

import { useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DbAccessControl,
  type ScopeDbAccess,
  type ScopeDbState,
} from "@/components/scope/db-access-control";
import { writeConsentGrants } from "@/app/oauth/consent/actions";

// Allow / Deny + project + per-database scope picker for the OAuth consent
// screen.
//
// One OAuth credential is bound to ONE project. The user picks a project — auto-
// selected only when unambiguous (a re-consent's existing binding, or the sole
// project), otherwise an explicit choice is required — and then which of that
// project's databases the agent may reach, at what access.
//
// On Allow: write the chosen project + per-DB grant set FIRST (server action →
// mcp_scope_grants, keyed by this OAuth client + the signed-in user), THEN post
// the decision to the Better Auth consent endpoint (/api/auth/oauth2/consent).
// The endpoint returns the redirect URI to send the MCP client back to. The
// agent's bearer is then enforced against the grant set on every request, and
// the region-wide /mcp endpoint resolves the bound project from it.
//
// On Deny: post the denial only — no grants written.
//
// Pure client component (no @midplane-cloud/db import) per the client-import
// rule; it talks to the auth API over HTTP and to the grant store via the
// server action. Prop types are declared inline (not imported from the
// server-only scope-grants lib) so nothing server-side leaks into the bundle.

type Access = ScopeDbAccess;
type DbState = ScopeDbState;

interface ConsentDatabase {
  projectDatabaseId: string;
  name: string;
}
interface ConsentProject {
  projectId: string;
  projectName: string | null;
  databases: ConsentDatabase[];
}

export interface ConsentFormProps {
  consentCode: string;
  clientId: string;
  projects: ConsentProject[];
  /** Project to pre-select: the credential's current binding on a re-consent, or
   *  null. No first-project fallback — the form auto-selects only a sole project
   *  and otherwise forces an explicit pick (account-wide URL, so a silent
   *  default would bind to the wrong project). */
  defaultProjectId: string | null;
  /** Prior grant (cdbId → access) so a re-consent pre-selects the last choice. */
  existing: Record<string, Access>;
}

export function ConsentForm({
  consentCode,
  clientId,
  projects,
  defaultProjectId,
  existing,
}: ConsentFormProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // The one project this credential will be bound to. Auto-select ONLY when the
  // choice is unambiguous: a re-consent's existing binding, or the sole project.
  // With multiple projects and no prior binding we leave it unselected and force
  // an explicit pick — the URL is account-wide, so a silent default to the first
  // project is exactly how an agent binds to the wrong one.
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    () => {
      if (
        defaultProjectId &&
        projects.some((p) => p.projectId === defaultProjectId)
      ) {
        return defaultProjectId;
      }
      return projects.length === 1 ? (projects[0]?.projectId ?? null) : null;
    },
  );
  const selectedProject = useMemo(
    () => projects.find((p) => p.projectId === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const selectedDbs = selectedProject?.databases ?? [];

  // cdbId → "none" | "read" | "write". Default unselected ("none") unless
  // previously granted, so consent is an explicit opt-IN per database. Prior
  // grants seed every project's DBs so switching back to the bound project
  // restores its selection.
  const [state, setState] = useState<Record<string, DbState>>(() => {
    const init: Record<string, DbState> = {};
    for (const p of projects) {
      for (const db of p.databases) {
        init[db.projectDatabaseId] = existing[db.projectDatabaseId] ?? "none";
      }
    }
    return init;
  });

  const selectedCount = selectedDbs.filter(
    (db) => (state[db.projectDatabaseId] ?? "none") !== "none",
  ).length;

  // Multiple projects and none chosen yet → block Allow until the user picks
  // one, so a credential is never bound by a silent default.
  const mustPickProject = projects.length > 1 && !selectedProjectId;

  function setDb(cdbId: string, value: DbState) {
    setState((s) => ({ ...s, [cdbId]: value }));
  }

  function setAll(value: DbState) {
    setState((s) => {
      const next = { ...s };
      for (const db of selectedDbs) next[db.projectDatabaseId] = value;
      return next;
    });
  }

  async function postDecision(accept: boolean): Promise<void> {
    const res = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accept, consent_code: consentCode }),
    });
    if (!res.ok) {
      setError("Could not record your decision. Please try again.");
      return;
    }
    const data = (await res.json()) as { redirectURI?: string };
    if (data.redirectURI) {
      window.location.href = data.redirectURI;
      return;
    }
    setError("Unexpected response from the authorization server.");
  }

  function decide(accept: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        // Only write grants when there's a project to bind to. With no projects
        // yet, approve the client with no grants (the proxy 403s until the user
        // grants access later) — matching the prior empty-selection behavior.
        if (accept && selectedProjectId) {
          const selections = selectedDbs
            .filter((db) => (state[db.projectDatabaseId] ?? "none") !== "none")
            .map((db) => ({
              projectDatabaseId: db.projectDatabaseId,
              access: state[db.projectDatabaseId] as Access,
            }));
          const grant = await writeConsentGrants(
            clientId,
            selectedProjectId,
            selections,
          );
          if (!grant.ok) {
            setError(
              "Could not save the database selection. Please try again.",
            );
            return;
          }
        }
        await postDecision(accept);
      } catch {
        setError("Network error. Please try again.");
      }
    });
  }

  const hasDbs = projects.length > 0;

  return (
    <div className="flex w-full flex-col gap-4">
      {hasDbs ? (
        <div className="w-full space-y-4 border border-border bg-card p-5">
          {projects.length > 1 ? (
            <div className="space-y-1.5">
              <label
                htmlFor="consent-project"
                className="text-sm font-medium text-foreground"
              >
                Project
              </label>
              <select
                id="consent-project"
                value={selectedProjectId ?? ""}
                disabled={pending}
                onChange={(e) =>
                  setSelectedProjectId(e.target.value || null)
                }
                className="w-full border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-[hsl(var(--brand))] focus:outline-none disabled:opacity-50"
              >
                <option value="" disabled>
                  Choose a project…
                </option>
                {projects.map((p) => (
                  <option key={p.projectId} value={p.projectId}>
                    {p.projectName || p.projectId}
                  </option>
                ))}
              </select>
              <p className="text-xs text-subtle">
                This agent connects to one project. Pick it, then choose its
                databases below.
              </p>
            </div>
          ) : (
            <p className="text-xs text-subtle">
              Connecting to{" "}
              <span className="font-medium text-foreground">
                {selectedProject?.projectName || selectedProject?.projectId}
              </span>
              . Pick its databases below.
            </p>
          )}

          {selectedProject ? (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-foreground">
                  Choose which databases this agent can use
                </p>
                <div className="flex gap-3 text-xs">
                  <button
                    type="button"
                    className="text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => setAll("read")}
                  >
                    All read
                  </button>
                  <button
                    type="button"
                    className="text-subtle underline-offset-2 hover:underline"
                    onClick={() => setAll("none")}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {selectedDbs.map((db) => (
                  <div
                    key={db.projectDatabaseId}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="font-mono text-sm text-foreground">
                      {db.name}
                    </span>
                    <DbAccessControl
                      value={state[db.projectDatabaseId] ?? "none"}
                      disabled={pending}
                      onChange={(v) => setDb(db.projectDatabaseId, v)}
                    />
                  </div>
                ))}
              </div>
              <p className="text-xs text-subtle">
                The agent can only reach the databases you select, at the access
                you grant. Each database&apos;s own policy and guardrails still
                apply on top.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Choose a project above to pick the databases this agent can use.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          You don&apos;t have any databases yet. You can approve this agent now
          and grant database access later from the dashboard.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-deny">
          {error}
        </p>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => decide(false)}
        >
          Deny
        </Button>
        <Button
          type="button"
          disabled={pending || mustPickProject}
          onClick={() => decide(true)}
          arrow
        >
          {pending
            ? "Authorizing…"
            : mustPickProject
              ? "Choose a project"
              : hasDbs
                ? `Allow access${selectedCount > 0 ? ` to ${selectedCount}` : ""}`
                : "Allow access"}
        </Button>
      </div>
    </div>
  );
}

