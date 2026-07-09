"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

// Regional "forgot password" form. Runs in the region that owns the account
// (the apex routes here first), so authClient.requestPasswordReset hits the
// right DB. redirectTo is this same regional origin's /reset-password — Better
// Auth emails a signed link that lands the user there with a ?token.
//
// The response is deliberately uniform whether or not the email exists (Better
// Auth returns success either way), so the confirmation never reveals existence.
export function ForgotPasswordForm({
  initialEmail = "",
}: {
  initialEmail?: string;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error: resetError } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setPending(false);
    if (resetError) {
      setError(resetError.message ?? "Could not send a reset email.");
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <>
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
            Check your email
          </h1>
          <p className="text-sm text-muted-foreground">
            If an account exists for{" "}
            <strong className="text-foreground">{email}</strong>, we&apos;ve sent
            a link to reset your password. It expires in 1 hour.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          <Link
            href="/sign-in"
            className="font-medium text-foreground underline underline-offset-2"
          >
            Back to sign in
          </Link>
        </p>
      </>
    );
  }

  return (
    <>
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
          Reset your password
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter your email and we&apos;ll send a reset link.
        </p>
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
            autoFocus
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
          className="w-full"
          size="lg"
          arrow
          disabled={pending}
        >
          {pending ? "Sending…" : "Send reset link"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">
        <Link
          href="/sign-in"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Back to sign in
        </Link>
      </p>
    </>
  );
}
