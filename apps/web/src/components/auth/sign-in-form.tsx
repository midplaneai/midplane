"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

// Email/password sign-in on the design-system primitives. Better Auth has no
// hosted UI (unlike Clerk's <SignIn/>), so this is the form. Social/SSO later.
export function SignInForm({ redirectTo = "/dashboard" }: { redirectTo?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
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
          href="/sign-up"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}
