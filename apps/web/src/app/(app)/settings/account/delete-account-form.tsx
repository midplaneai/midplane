"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

// Account-deletion confirmation. Two shapes, chosen by `mode` (the server
// computes it from classifyAccountDeletion):
//
//  - "delete-workspace": you're the sole member, so deleting your account tears
//    the whole workspace down. Confirm by typing the workspace name — the same
//    high-friction confirmation a destructive workspace action deserves.
//  - "leave": you're a non-owner; deletion just removes your membership. Confirm
//    by typing "delete my account".
//
// Credential users also enter their password (Better Auth requires it to delete
// a password account); OAuth-only users rely on their fresh session. On success
// Better Auth ends the session, so we route home.
export function DeleteAccountForm({
  mode,
  workspaceName,
  hasPassword,
}: {
  mode: "delete-workspace" | "leave";
  workspaceName: string;
  hasPassword: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");

  const requiredPhrase =
    mode === "delete-workspace" ? workspaceName : "delete my account";
  const phraseOk = confirm.trim() === requiredPhrase;
  const passwordOk = !hasPassword || password.length > 0;
  const canSubmit = phraseOk && passwordOk && !pending;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!phraseOk || !passwordOk) return;

    startTransition(async () => {
      const res = await authClient.deleteUser(
        hasPassword ? { password } : {},
      );
      if (res.error) {
        setError(
          res.error.message ??
            "Couldn’t delete your account. Try signing out and back in, then retry.",
        );
        return;
      }
      // Session is gone — leave the app.
      router.push("/");
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="delete-confirm">
          {mode === "delete-workspace" ? (
            <>
              Type the workspace name{" "}
              <span className="font-mono normal-case text-foreground">
                {workspaceName}
              </span>{" "}
              to confirm
            </>
          ) : (
            <>
              Type{" "}
              <span className="font-mono normal-case text-foreground">
                delete my account
              </span>{" "}
              to confirm
            </>
          )}
        </Label>
        <Input
          id="delete-confirm"
          name="confirm"
          type="text"
          autoComplete="off"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            setError(null);
          }}
          className="sm:max-w-[360px]"
        />
      </div>

      {hasPassword ? (
        <div className="space-y-1.5">
          <Label htmlFor="delete-password">Your password</Label>
          <Input
            id="delete-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
            className="sm:max-w-[360px]"
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button
          type="submit"
          variant="destructive"
          size="sm"
          disabled={!canSubmit}
        >
          {pending
            ? "Deleting…"
            : mode === "delete-workspace"
              ? "Delete account & workspace"
              : "Delete account"}
        </Button>
        {error ? (
          <span className="text-xs text-destructive">{error}</span>
        ) : null}
      </div>
    </form>
  );
}
