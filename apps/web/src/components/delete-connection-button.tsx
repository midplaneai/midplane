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

// Renders the destructive Delete button + a shadcn AlertDialog confirmation.
// The actual delete is a Server Action passed in from the dashboard
// (action prop) — Next.js serializes the reference so this client component
// can submit the form against it.

export function DeleteConnectionButton({
  id,
  action,
  label = "Delete",
}: {
  id: string;
  action: (formData: FormData) => Promise<void>;
  label?: string;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this connection?</AlertDialogTitle>
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
            <AlertDialogAction type="submit">
              Delete connection
            </AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
