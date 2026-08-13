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

// Delete one database off a project, from the workspace's Database pane.
// Mirrors DeleteProjectButton (AlertDialog confirm → server action), but
// scoped to a single child DB. Deleting the only database is allowed and
// leaves the project in its setup state, so `isOnly` only changes the
// consequence the confirm spells out — never whether the action is offered.

export function DeleteDatabaseButton({
  name,
  action,
  isOnly,
}: {
  name: string;
  action: (formData: FormData) => Promise<void>;
  isOnly?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          Delete database
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {isOnly ? (
              <>
                Agents lose access immediately. Its policy and encrypted
                credential are removed, and any machine token scoped to only
                this database is revoked. This is the project&apos;s only
                database, so the project stays — with its name, its other
                tokens and its audit history — but nothing can be queried
                through it until you add another. This can&apos;t be undone.
              </>
            ) : (
              <>
                Agents lose access to this database immediately. Its policy and
                encrypted credential are removed, and any machine token scoped
                to only this database is revoked. The project and its other
                databases are untouched. This can&apos;t be undone.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={action}>
            <AlertDialogAction type="submit">Delete database</AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
