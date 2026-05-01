"use client";

import { MoreHorizontal } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Per-DB [⋯] menu rendered next to each database row on the dashboard.
// Three items: rotate DSN (links to the per-DB detail route, where the
// rotate form lives), rename DB, and remove DB. The parent row owns
// the rename / remove modals and passes click handlers down so the
// menu's onSelect can flip them into the visible state.
//
// Removal of the only DB on a connection is blocked at the lib layer
// (LastDatabaseProtected); the menu also disables the Remove item when
// `disableRemove` is true so the user gets the explanation up front
// instead of a thrown error after-the-fact.

export function DatabaseRowMenu({
  connectionId,
  dbName,
  disableRemove,
  onRename,
  onRemove,
}: {
  connectionId: string;
  dbName: string;
  disableRemove: boolean;
  onRename: () => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Actions for database ${dbName}`}
          className="h-7 w-7"
        >
          <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href={`/connections/${connectionId}/databases/${dbName}`}>
            Edit policy & rotate DSN
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onRename();
          }}
        >
          Rename database
        </DropdownMenuItem>
        <DropdownMenuItem
          destructive
          disabled={disableRemove}
          title={
            disableRemove
              ? "A connection must keep at least one database"
              : undefined
          }
          onSelect={(e) => {
            e.preventDefault();
            if (!disableRemove) onRemove();
          }}
        >
          Remove database
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
