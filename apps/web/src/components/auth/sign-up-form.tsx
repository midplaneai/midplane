"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

// Email/password sign-up on the design-system primitives. On success Better
// Auth signs the user in automatically; we route to the region picker, which
// creates the organization + customer row (the signup-completion step).
export function SignUpForm({
  redirectTo = "/signup/region",
}: {
  redirectTo?: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error } = await authClient.signUp.email({ name, email, password });
    if (error) {
      setError(error.message ?? "Could not create your account.");
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
          Create your account
        </h1>
        <p className="text-sm text-muted-foreground">
          Safe Postgres for your team&apos;s AI agents.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
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
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">At least 8 characters.</p>
        </div>

        {error && (
          <p role="alert" className="text-sm text-[hsl(var(--deny))]">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" size="lg" arrow disabled={pending}>
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/sign-in"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
