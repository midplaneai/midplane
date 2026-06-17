"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

// Allow / Deny control for the OAuth consent screen. Posts the user's decision
// to the Better Auth `mcp` plugin's consent endpoint (/api/auth/oauth2/consent,
// re-exported from oidc-provider). The endpoint returns the redirect URI to
// send the MCP client back to — with an authorization code on accept, or an
// access_denied error on deny. Same-origin fetch carries the session cookie.
//
// Pure client component (no @midplane-cloud/db import) per the client-import
// rule — it only talks to the auth API over HTTP.
export function ConsentForm({ consentCode }: { consentCode: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function decide(accept: boolean) {
    setError(null);
    startTransition(async () => {
      try {
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
      } catch {
        setError("Network error. Please try again.");
      }
    });
  }

  return (
    <div className="flex w-full flex-col gap-3">
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
          disabled={pending}
          onClick={() => decide(true)}
          arrow
        >
          {pending ? "Authorizing…" : "Allow access"}
        </Button>
      </div>
    </div>
  );
}
