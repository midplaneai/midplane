"use client";

import { useState, useTransition } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

// Per-row revoke confirm. Mirrors DeleteConnectionButton's posture
// (AlertDialog + Server Action submit), with the dialog body parametrized
// on the token name so the customer sees which row they're revoking. The
// destructive action is the only style the deny-color is used for here —
// the badge variants in the list itself remain visually distinct.
//
// The lib's revokeToken is idempotent against already-revoked rows, so a
// double-click is safe — the second submit returns the same id without
// rewriting timestamps.

export type RevokeTokenAction = (
  connectionId: string,
  tokenId: string,
) => Promise<
  | { ok: true; id: string }
  | { ok: false; error: "not_found" | "internal" }
>;

export function RevokeTokenButton({
  connectionId,
  tokenId,
  tokenName,
  action,
}: {
  connectionId: string;
  tokenId: string;
  tokenName: string;
  action: RevokeTokenAction;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await action(connectionId, tokenId);
      if (result.ok) {
        setOpen(false);
        return;
      }
      setError(
        result.error === "not_found"
          ? "That token is no longer available. Refresh the page."
          : "Something went wrong. Try again.",
      );
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="revoke-token">
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke this token?</AlertDialogTitle>
          <AlertDialogDescription>
            <span className="font-mono text-foreground">{tokenName}</span>{" "}
            stops working immediately — any agent still using it will get a
            404 on the next request. This can&apos;t be undone. Create a new
            token to replace it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p
            role="alert"
            className="text-xs text-[hsl(var(--deny))]"
            data-testid="revoke-token-error"
          >
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            type="button"
            onClick={(e) => {
              // AlertDialog's default behavior closes on action click,
              // but we want to stay open while the action runs so the
              // pending state is visible. Prevent default close; the
              // onConfirm path closes the dialog only on success.
              e.preventDefault();
              onConfirm();
            }}
            disabled={pending}
            className="bg-[hsl(var(--deny))] text-[hsl(var(--deny-foreground,var(--background)))] hover:bg-[hsl(var(--deny)/0.9)]"
          >
            {pending ? "Revoking…" : "Revoke"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
