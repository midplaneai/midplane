"use client";

import { useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { writeConsentGrants } from "@/app/oauth/consent/actions";

// Allow / Deny + per-database scope picker for the OAuth consent screen.
//
// On Allow: write the chosen per-DB grant set FIRST (server action →
// mcp_scope_grants, keyed by this OAuth client + the signed-in user), THEN post
// the decision to the Better Auth consent endpoint (/api/auth/oauth2/consent).
// The endpoint returns the redirect URI to send the MCP client back to. The
// agent's bearer is then enforced against the grant set on every request.
//
// On Deny: post the denial only — no grants written.
//
// Pure client component (no @midplane-cloud/db import) per the client-import
// rule; it talks to the auth API over HTTP and to the grant store via the
// server action. Prop types are declared inline (not imported from the
// server-only scope-grants lib) so nothing server-side leaks into the bundle.

type Access = "read" | "write";
type DbState = "none" | Access;

interface ConsentDatabase {
  connectionDatabaseId: string;
  name: string;
}
interface ConsentConnection {
  connectionId: string;
  connectionName: string | null;
  databases: ConsentDatabase[];
}

export interface ConsentFormProps {
  consentCode: string;
  clientId: string;
  connections: ConsentConnection[];
  /** Prior grant (cdbId → access) so a re-consent pre-selects the last choice. */
  existing: Record<string, Access>;
}

export function ConsentForm({
  consentCode,
  clientId,
  connections,
  existing,
}: ConsentFormProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const allDbs = useMemo(
    () => connections.flatMap((c) => c.databases),
    [connections],
  );

  // cdbId → "none" | "read" | "write". Default a DB to its prior grant, else
  // "read" (the safe default a user is most likely to want) — but only DBs the
  // user flips off "none"... no: default unselected ("none") unless previously
  // granted, so consent is an explicit opt-IN per database.
  const [state, setState] = useState<Record<string, DbState>>(() => {
    const init: Record<string, DbState> = {};
    for (const db of allDbs) {
      init[db.connectionDatabaseId] = existing[db.connectionDatabaseId] ?? "none";
    }
    return init;
  });

  const selectedCount = Object.values(state).filter((v) => v !== "none").length;

  function setDb(cdbId: string, value: DbState) {
    setState((s) => ({ ...s, [cdbId]: value }));
  }

  function setAll(value: DbState) {
    setState(() => {
      const next: Record<string, DbState> = {};
      for (const db of allDbs) next[db.connectionDatabaseId] = value;
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
        if (accept) {
          const selections = Object.entries(state)
            .filter(([, v]) => v !== "none")
            .map(([connectionDatabaseId, v]) => ({
              connectionDatabaseId,
              access: v as Access,
            }));
          const grant = await writeConsentGrants(clientId, selections);
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

  const hasDbs = allDbs.length > 0;

  return (
    <div className="flex w-full flex-col gap-4">
      {hasDbs ? (
        <div className="w-full space-y-4 border border-border bg-card p-5">
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

          <div className="space-y-4">
            {connections.map((conn) => (
              <fieldset key={conn.connectionId} className="space-y-2">
                <legend className="text-xs font-medium uppercase tracking-wide text-subtle">
                  {conn.connectionName || conn.connectionId}
                </legend>
                {conn.databases.map((db) => (
                  <div
                    key={db.connectionDatabaseId}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="font-mono text-sm text-foreground">
                      {db.name}
                    </span>
                    <AccessControl
                      value={state[db.connectionDatabaseId] ?? "none"}
                      disabled={pending}
                      onChange={(v) => setDb(db.connectionDatabaseId, v)}
                    />
                  </div>
                ))}
              </fieldset>
            ))}
          </div>
          <p className="text-xs text-subtle">
            The agent can only reach the databases you select, at the access you
            grant. Each database&apos;s own policy and guardrails still apply on
            top.
          </p>
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
        <Button type="button" disabled={pending} onClick={() => decide(true)} arrow>
          {pending
            ? "Authorizing…"
            : hasDbs
              ? `Allow access${selectedCount > 0 ? ` to ${selectedCount}` : ""}`
              : "Allow access"}
        </Button>
      </div>
    </div>
  );
}

// Three-way per-DB control: No access / Read / Write. A segmented set of
// buttons (accessible, no native-select styling drift) using semantic tokens.
function AccessControl({
  value,
  disabled,
  onChange,
}: {
  value: DbState;
  disabled: boolean;
  onChange: (v: DbState) => void;
}) {
  const options: Array<{ v: DbState; label: string }> = [
    { v: "none", label: "No access" },
    { v: "read", label: "Read" },
    { v: "write", label: "Write" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Database access"
      className="inline-flex overflow-hidden border border-border"
    >
      {options.map((o) => {
        const active = value === o.v;
        return (
          <button
            key={o.v}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.v)}
            className={[
              "px-2.5 py-1 text-xs transition-colors",
              active
                ? o.v === "write"
                  ? "bg-warn/15 font-medium text-warn"
                  : o.v === "read"
                    ? "bg-allow/15 font-medium text-allow"
                    : "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/60",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
