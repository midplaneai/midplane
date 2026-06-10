"use client";

import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Per-connection [⋯] menu. Two items per the locked design: settings (links
// to the settings page) and delete (opens an AlertDialog confirm). Both
// kept here together so the row only renders one trigger.

export function ConnectionRowMenu({
  id,
  name,
  deleteAction,
}: {
  id: string;
  name: string | null;
  deleteAction: (formData: FormData) => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const label = name ?? "this connection";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Connection actions"
            className="h-8 w-8"
          >
            <MoreHorizontal className="h-4 w-4" strokeWidth={1.5} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            {/* The home page carries databases + the test panel too;
                the anchor lands this entry on its tokens section. */}
            <Link href={`/connections/${id}#tokens`}>Connect an agent</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={`/connections/${id}/settings`}>
              Connection settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            destructive
            onSelect={(e) => {
              e.preventDefault();
              setConfirmOpen(true);
            }}
          >
            Delete connection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The MCP token stops working immediately — any agent using it
              will get a 404. The encrypted DSN row is removed. This
              can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <form action={deleteAction}>
              <input type="hidden" name="id" value={id} />
              <AlertDialogAction type="submit">
                Delete connection
              </AlertDialogAction>
            </form>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
