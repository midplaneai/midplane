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
// scoped to a single child DB. Disabled when it's the only database — the
// server still enforces this (LastDatabaseProtected); the disabled trigger
// just keeps the dead path out of normal UI.

export function DeleteDatabaseButton({
  name,
  action,
  disabled,
}: {
  name: string;
  action: (formData: FormData) => Promise<void>;
  disabled?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          Delete database
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Agents lose access to this database immediately. Its policy and
            encrypted credential are removed. The project and its other
            databases are untouched. This can&apos;t be undone.
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
