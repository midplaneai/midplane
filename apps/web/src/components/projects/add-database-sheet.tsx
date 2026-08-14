"use client";

import { Plus } from "lucide-react";
import { useState } from "react";

import { AddDatabaseForm } from "@/components/dashboard/add-database-form";
import { buttonVariants } from "@/components/ui/button";
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
//
// `first` is the empty-project case: the same sheet, but it's the project's
// PRIMARY call to action rather than one more affordance under a row of
// existing databases, so the trigger takes the solid button treatment and the
// copy says "first". This is the path that used to send the user to
// /projects/new — a route that creates PROJECTS — which made the button's
// promise depend on which page you clicked it from.

export function AddDatabaseSheet({
  projectId,
  addAction,
  first = false,
}: {
  projectId: string;
  addAction: (formData: FormData) => Promise<void>;
  first?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          className={
            first
              ? buttonVariants({ size: "sm" })
              : "inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-2 text-sm text-subtle transition-colors hover:border-border-strong hover:text-foreground"
          }
        >
          {first ? null : (
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          )}
          {first ? "Add a database" : "Add database"}
        </button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{first ? "Add a database" : "Add database"}</SheetTitle>
          <SheetDescription>
            {first
              ? "Paste a Postgres connection string. We encrypt it with your region's KMS key and never persist the plaintext."
              : "Expose another Postgres database under the same MCP endpoint. It gets its own policy and credential and appears as a tab."}
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
