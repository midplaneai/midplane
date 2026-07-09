"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

// Sets a new password from a valid reset token. On success Better Auth updates
// the credential and (per revokeSessionsOnPasswordReset in lib/auth.ts) drops
// every other live session; it does NOT sign the user in, so we send them to
// /sign-in to log in with the new password.
export function ResetPasswordForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setPending(true);
    const { error: resetError } = await authClient.resetPassword({
      newPassword: password,
      token,
    });
    if (resetError) {
      setError(
        resetError.message ??
          "Could not reset your password. Request a new link and try again.",
      );
      setPending(false);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <>
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
            Password updated
          </h1>
          <p className="text-sm text-muted-foreground">
            Your password has been changed. Any other sessions have been signed
            out.
          </p>
        </div>
        <Link
          href="/sign-in"
          className={cn(buttonVariants({ size: "lg" }), "w-full")}
        >
          Sign in
          <span aria-hidden className="ml-2.5 font-mono">
            →
          </span>
        </Link>
      </>
    );
  }

  return (
    <>
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
          Choose a new password
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter a new password for your account.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">At least 8 characters.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
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
          {pending ? "Updating…" : "Update password"}
        </Button>
      </form>
    </>
  );
}
