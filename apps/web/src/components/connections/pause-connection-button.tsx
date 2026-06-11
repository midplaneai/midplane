"use client";

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

// Pause button + AlertDialog confirmation. Pause is reversible, so this is
// NOT a destructive (red) action — but it does cut off live agent traffic
// the instant it lands, so a confirm beat is warranted (same pattern as
// DeleteConnectionButton, minus the irreversibility). The pause itself is a
// Server Action passed in from the connection workspace.
//
// Resume needs no dialog (it only restores service) — the workspace renders
// it as a bare form, so there's no matching ResumeConnectionButton here.

export function PauseConnectionButton({
  id,
  action,
}: {
  id: string;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          Pause connection
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Pause this connection?</AlertDialogTitle>
          <AlertDialogDescription>
            Every agent request is rejected immediately — but the tokens,
            URLs, and policy stay exactly as they are. Resume restores service
            in one click, with the same URLs. Nothing is deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={action}>
            <input type="hidden" name="id" value={id} />
            <AlertDialogAction type="submit">
              Pause connection
            </AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
