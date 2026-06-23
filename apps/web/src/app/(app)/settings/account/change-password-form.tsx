"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

// Change-password form for credential (email/password) users. Rendered only when
// the user has a password account — OAuth-only users see a note instead, since
// they have no password to rotate. Calls authClient.changePassword, which
// verifies the current password server-side; revokeOtherSessions logs out the
// user's other devices on a successful change (the active session stays).
//
// Better Auth's client methods return { error } rather than throwing, so we
// branch on the result instead of try/catch.
const MIN_PASSWORD = 8;

export function ChangePasswordForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setDone(false);

    const form = event.currentTarget;
    const fd = new FormData(form);
    const currentPassword = String(fd.get("current") ?? "");
    const newPassword = String(fd.get("next") ?? "");
    const confirm = String(fd.get("confirm") ?? "");

    if (newPassword.length < MIN_PASSWORD) {
      setError(`New password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (newPassword !== confirm) {
      setError("New passwords don’t match.");
      return;
    }

    startTransition(async () => {
      const res = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      });
      if (res.error) {
        setError(res.error.message ?? "Couldn’t change your password.");
        return;
      }
      form.reset();
      setDone(true);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2 sm:max-w-[50%]">
          <Label htmlFor="current">Current password</Label>
          <Input
            id="current"
            name="current"
            type="password"
            required
            autoComplete="current-password"
            onChange={() => {
              setError(null);
              setDone(false);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="next">New password</Label>
          <Input
            id="next"
            name="next"
            type="password"
            required
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            onChange={() => {
              setError(null);
              setDone(false);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm">Confirm new password</Label>
          <Input
            id="confirm"
            name="confirm"
            type="password"
            required
            autoComplete="new-password"
            minLength={MIN_PASSWORD}
            onChange={() => {
              setError(null);
              setDone(false);
            }}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Updating…" : "Update password"}
        </Button>
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : null}
        {done ? (
          <span className="text-xs text-[hsl(var(--allow))]">
            Password updated · other sessions signed out
          </span>
        ) : null}
      </div>
    </form>
  );
}
