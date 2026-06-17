"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

// "Sign in with SSO" — the SAML/OIDC entry on the sign-in page. Rendered only
// when the build ships Enterprise SSO (the page gates on eeBuildEnabled()); the
// authClient.signIn.sso method comes from the ssoClient plugin, harmless without
// the server plugin. We match the provider by the work-email domain: the user
// enters their email, Better Auth finds the org's registered provider and
// redirects to the identity provider.
export function SsoSignIn({ redirectTo = "/dashboard" }: { redirectTo?: string }) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { data, error: ssoError } = await authClient.signIn.sso({
      email,
      callbackURL: redirectTo,
    });
    if (ssoError) {
      setError(
        ssoError.message ??
          "No single sign-on is configured for that email domain.",
      );
      setPending(false);
      return;
    }
    // The provider match returns the IdP redirect URL; hand the browser off to
    // the identity provider. (The client may also redirect itself; this is the
    // explicit fallback.)
    const url = (data as { url?: string } | null)?.url;
    if (url) {
      window.location.href = url;
      return;
    }
    setPending(false);
  }

  return (
    <div className="mt-8">
      <div className="mb-6 flex items-center gap-4">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs lowercase text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={onSubmit} className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="sso-email">Work email</Label>
          <Input
            id="sso-email"
            name="sso-email"
            type="email"
            autoComplete="email"
            required
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-[hsl(var(--deny))]">
            {error}
          </p>
        )}

        <Button
          type="submit"
          variant="secondary"
          className="w-full"
          size="lg"
          arrow
          disabled={pending}
        >
          {pending ? "Redirecting…" : "Continue with SSO"}
        </Button>
      </form>
    </div>
  );
}
