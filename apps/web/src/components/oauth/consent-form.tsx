"use client";

import { useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
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
  // With databases on offer but none granted, approving is the degenerate path
  // (the agent connects, then 403s on every query). Demote it visually — the
  // filled primary style is reserved for approving an actual grant. Keyed on
  // selectedDbs (not hasDbs): "chose nothing" earns the demotion, "nothing to
  // choose" does not.
  const zeroGrant =
    selectedDbs.length > 0 && !mustPickProject && selectedCount === 0;

  return (
    <div className="flex w-full flex-col gap-4">
      {hasDbs ? (
        <div className="w-full space-y-4 border border-border bg-card p-5">
          {projects.length > 1 ? (
            <div className="space-y-1.5">
              <label htmlFor="consent-project">
                <SectionLabel>Project</SectionLabel>
              </label>
              <select
                id="consent-project"
                value={selectedProjectId ?? ""}
                disabled={pending}
                onChange={(e) =>
                  setSelectedProjectId(e.target.value || null)
                }
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
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
                One agent credential connects to one project.
              </p>
            </div>
          ) : (
            <div className="flex items-baseline justify-between gap-3">
              <SectionLabel>Project</SectionLabel>
              <span className="min-w-0 truncate font-mono text-sm text-foreground">
                {selectedProject?.projectName || selectedProject?.projectId}
              </span>
            </div>
          )}

          {selectedProject ? (
            <div className="space-y-3 border-t border-border pt-4">
              <div className="flex items-baseline justify-between">
                <SectionLabel>Database access</SectionLabel>
                {selectedDbs.length > 1 && (
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
                )}
              </div>

              <div className="space-y-2">
                {selectedDbs.map((db) => (
                  <div
                    key={db.projectDatabaseId}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="min-w-0 truncate font-mono text-sm text-foreground">
                      {db.name}
                    </span>
                    <DbAccessControl
                      value={state[db.projectDatabaseId] ?? "none"}
                      disabled={pending}
                      onChange={(v) => setDb(db.projectDatabaseId, v)}
                      label={db.name}
                    />
                  </div>
                ))}
              </div>
              {selectedCount === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Nothing selected — the agent connects but can&apos;t query
                  anything until you grant access.
                </p>
              ) : (
                <p className="text-xs text-subtle">
                  The agent reaches only the databases you select. Each
                  database&apos;s own policy and guardrails still apply.
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Choose a project to pick its databases.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No databases yet — approve this agent now and grant access later by
          re-running this flow.
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
          // secondary, not outline: the demoted approve must never be a visual
          // twin of the adjacent Deny (opposite decisions on a consent screen).
          variant={zeroGrant ? "secondary" : "default"}
          disabled={pending || mustPickProject}
          onClick={() => decide(true)}
          arrow={!zeroGrant}
        >
          {pending
            ? "Authorizing…"
            : mustPickProject
              ? "Choose a project"
              : selectedCount > 0
                ? `Allow access to ${selectedCount} database${selectedCount === 1 ? "" : "s"}`
                : zeroGrant
                  ? "Connect without database access"
                  : "Connect agent"}
        </Button>
      </div>
    </div>
  );
}

