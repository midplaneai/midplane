"use client";

import { useState } from "react";

import { RotateConnectionForm } from "@/components/rotate-connection-form";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

// Rotate the stored credential from a side panel — an occasional, focused
// task, so it lives behind an Actions button instead of an always-open card.
// Closes on a committed rotation.

export function RotateCredentialSheet({
  id,
  dbName,
  action,
  lastRotatedLabel,
}: {
  id: string;
  dbName: string;
  action: (formData: FormData) => Promise<void>;
  lastRotatedLabel?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          Rotate connection string…
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Rotate connection string</SheetTitle>
          <SheetDescription>
            Replace the encrypted credential for{" "}
            <span className="font-mono text-foreground">{dbName}</span>. The MCP
            endpoint URL stays the same; running sessions are torn down so the
            new credentials take effect on the next request.
            {lastRotatedLabel ? ` ${lastRotatedLabel}` : ""}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <RotateConnectionForm
            id={id}
            action={action}
            onSuccess={() => setOpen(false)}
          />
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
