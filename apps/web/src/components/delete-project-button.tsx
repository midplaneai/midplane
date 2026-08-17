"use client";

import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";

// Renders the destructive Delete button + a shadcn AlertDialog confirmation.
// The actual delete is a Server Action passed in from the dashboard
// (action prop) — Next.js serializes the reference so this client component
// can submit the form against it.
//
// The confirm is a SubmitButton rather than AlertDialogAction (which is a
// Dialog.Close and dismissed the dialog on click, before the action had
// started): deleting tears down the engine machine and revokes tokens, so it
// takes seconds. The dialog now holds with "Deleting…" until the action
// settles, then closes via onSettled — on success the revalidated tree has
// usually already unmounted this row.

export function DeleteProjectButton({
  id,
  action,
  label = "Delete",
}: {
  id: string;
  action: (formData: FormData) => Promise<void>;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this project?</AlertDialogTitle>
          <AlertDialogDescription>
            The MCP token stops working immediately — any agent using it will
            get a 404. The encrypted DSN row is removed. This can&apos;t be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={action}>
            <input type="hidden" name="id" value={id} />
            <SubmitButton
              pendingLabel="Deleting…"
              onSettled={() => setOpen(false)}
            >
              Delete project
            </SubmitButton>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
