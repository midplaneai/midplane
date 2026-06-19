"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

// "Continue with Google" — the OAuth entry on the sign-in / sign-up pages.
// Rendered only when the build ships Google creds (the pages gate on
// googleAuthEnabled()); authClient.signIn.social is core (no plugin needed).
// signIn.social REDIRECTS the browser to Google and back to callbackURL, so —
// unlike the email form — there's no router.push here. A brand-new user who
// lands on /dashboard without an org is bounced to /signup/region by
// currentCustomer() (the org/customer is created there), so sign-in and sign-up
// can share the same flow; the page just passes the right callbackURL.
export function GoogleSignIn({
  redirectTo = "/dashboard",
  label = "Continue with Google",
}: {
  redirectTo?: string;
  label?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onClick() {
    setError(null);
    setPending(true);
    const { error: socialError } = await authClient.signIn.social({
      provider: "google",
      callbackURL: redirectTo,
    });
    // On success the browser is already redirecting; we only get here on a
    // failure to start the flow.
    if (socialError) {
      setError(socialError.message ?? "Could not start Google sign-in.");
      setPending(false);
    }
  }

  return (
    <div className="mt-8">
      <div className="mb-6 flex items-center gap-4">
        <span className="h-px flex-1 bg-border" />
        <span className="text-xs lowercase text-muted-foreground">or</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        size="lg"
        onClick={onClick}
        disabled={pending}
      >
        <GoogleMark />
        {pending ? "Redirecting…" : label}
      </Button>

      {error && (
        <p role="alert" className="mt-3 text-sm text-[hsl(var(--deny))]">
          {error}
        </p>
      )}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg
      className="mr-2 h-4 w-4"
      viewBox="0 0 18 18"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.1818l-2.9087-2.2581c-.806.54-1.8368.8591-3.0477.8591-2.344 0-4.3282-1.5831-5.0364-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.9636 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1022-1.17.2822-1.71V4.9582H.9573C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9573 4.0418L3.9636 10.71z"
      />
      <path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.9636 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
      />
    </svg>
  );
}
