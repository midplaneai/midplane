"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { AddDatabaseForm } from "@/components/dashboard/add-database-form";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

// "+ Add database" as a side-panel form rather than an inline expander —
// occasional, multi-field, focused, so it earns a deferred surface (the
// progressive-disclosure call). Closes itself on a committed add; the new
// database paints as a tab via the action's revalidate.

export function AddDatabaseSheet({
  projectId,
  addAction,
}: {
  projectId: string;
  addAction: (formData: FormData) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-sm text-subtle transition-colors hover:border-border-strong hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          Add database
        </button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Add database</SheetTitle>
          <SheetDescription>
            Expose another Postgres database under the same MCP endpoint. It
            gets its own policy and credential and appears as a tab.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <AddDatabaseForm
            embedded
            projectId={projectId}
            action={addAction}
            onClose={() => setOpen(false)}
          />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
