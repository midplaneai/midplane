"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { stampRegionCookie } from "@/lib/region-cookie-action";

// Email/password sign-in on the design-system primitives. Better Auth has no
// hosted UI (unlike Clerk's <SignIn/>), so this is the form. Social/SSO later.
//
// initialEmail prefills the field when the apex sign-in router redirected here
// with a signed email hint (the returning user typed it on the apex).
//
// createAccountHref defaults to the region picker (/signup), NOT /sign-up: a new
// user who lands on a regional sign-in page (e.g. the apex router sent an
// unrecognized email to us.app/sign-in) must choose a region before signing up,
// since region is permanent. Self-host — which has no picker — overrides it to
// /sign-up.
export function SignInForm({
  redirectTo = "/dashboard",
  initialEmail = "",
  createAccountHref = "/signup",
}: {
  redirectTo?: string;
  initialEmail?: string;
  createAccountHref?: string;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error } = await authClient.signIn.email({ email, password });
    if (error) {
      setError(
        error.message ?? "Could not sign in. Check your email and password.",
      );
      setPending(false);
      return;
    }
    // Region-stick this browser: auth is region-resident, so a successful
    // sign-in means this app's region owns the account. Next apex visit routes
    // straight here. Best-effort (never blocks the redirect below).
    await stampRegionCookie();
    router.push(redirectTo);
    router.refresh();
  }

  return (
    <div className="w-full max-w-[400px]">
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
          Sign in
        </h1>
        <p className="text-sm text-muted-foreground">Welcome back to Midplane.</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-[hsl(var(--deny))]">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" size="lg" arrow disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">
        New to Midplane?{" "}
        <Link
          href={createAccountHref}
          className="font-medium text-foreground underline underline-offset-2"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}
