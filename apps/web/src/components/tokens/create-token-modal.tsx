"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import { useId, useState, useTransition } from "react";

import { ShowOnceUrl } from "@/components/show-once-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// Create-token modal. Triggered by the [+ New token] button in the
// Tokens list panel header. Two surfaces inside the same modal:
//   1. The form (name + expiry).
//   2. After a successful submit, the show-once URL surface — the
//      plaintext is in React state, never round-tripped through a
//      cookie/session (unlike the connection-create flow which has to
//      cross a redirect boundary). The "I've saved it" button discards
//      the plaintext from state and closes the modal.
//
// On a successful create the action calls revalidatePath() for the
// connection page so the new row appears in the list when the modal
// closes — no additional refresh logic needed here.

export type CreateTokenAction = (
  connectionId: string,
  input: { name: string; expiresInDays: 30 | 90 | 365 | null },
) => Promise<
  | { ok: true; mcpUrl: string; id: string; name: string }
  | {
      ok: false;
      error:
        | "name_required"
        | "name_too_long"
        | "name_taken"
        | "not_found"
        | "expiry_in_past"
        | "internal";
    }
>;

interface CreateTokenModalProps {
  connectionId: string;
  action: CreateTokenAction;
}

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days (recommended)", days: 90 },
  { value: "365", label: "365 days", days: 365 },
  { value: "never", label: "Never expires", days: null },
] as const;

const DEFAULT_EXPIRY = "90";

export function CreateTokenModal({
  connectionId,
  action,
}: CreateTokenModalProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<string>(DEFAULT_EXPIRY);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);
  const nameId = useId();
  const expiryId = useId();

  function reset() {
    setName("");
    setExpiry(DEFAULT_EXPIRY);
    setError(null);
    setMcpUrl(null);
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      // Closing — flush state so the next open is a fresh form. The
      // plaintext is dropped here, which is the intended security
      // behavior: dismissing the modal without copying means the user
      // must revoke and create a new one (same UX as Stripe).
      reset();
    }
    setOpen(next);
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Give the token a name so you can tell it apart later.");
      return;
    }
    if (trimmed.length > 64) {
      setError("Names must be 64 characters or fewer.");
      return;
    }
    const choice = EXPIRY_OPTIONS.find((o) => o.value === expiry);
    if (!choice) {
      setError("Pick an expiry.");
      return;
    }

    startTransition(async () => {
      const result = await action(connectionId, {
        name: trimmed,
        expiresInDays: choice.days,
      });
      if (result.ok) {
        setMcpUrl(result.mcpUrl);
        return;
      }
      setError(messageForError(result.error));
    });
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
      <DialogPrimitive.Trigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-3.5 w-3.5" strokeWidth={1.5} />
          New token
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-background/60",
            "motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out",
            "motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=open]:fade-in-0",
          )}
        />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2",
            "rounded-lg border border-border bg-card p-6 shadow-lg",
            "motion-safe:duration-200 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out",
            "motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=open]:fade-in-0",
          )}
        >
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-sm text-subtle transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </DialogPrimitive.Close>
          {mcpUrl ? (
            <SuccessPanel
              mcpUrl={mcpUrl}
              onClose={() => handleOpenChange(false)}
            />
          ) : (
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="space-y-1">
                <DialogPrimitive.Title className="text-base font-medium text-foreground">
                  New token
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="text-xs text-muted-foreground">
                  Mint a credential for one agent. Give it a label you&apos;ll
                  recognize later — names are shown next to the last-used
                  timestamp in the dashboard.
                </DialogPrimitive.Description>
              </div>
              <div className="space-y-2">
                <Label htmlFor={nameId}>Name</Label>
                <Input
                  id={nameId}
                  name="name"
                  type="text"
                  required
                  maxLength={64}
                  placeholder="Dustin's laptop"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={pending}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={expiryId}>Expiry</Label>
                <select
                  id={expiryId}
                  name="expiry"
                  value={expiry}
                  onChange={(e) => setExpiry(e.target.value)}
                  disabled={pending}
                  className={cn(
                    "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                    "ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )}
                >
                  {EXPIRY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              {error ? (
                <p
                  role="alert"
                  className="text-xs text-[hsl(var(--deny))]"
                  data-testid="create-token-error"
                >
                  {error}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleOpenChange(false)}
                  disabled={pending}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={pending}>
                  {pending ? "Creating…" : "Create token"}
                </Button>
              </div>
            </form>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function SuccessPanel({
  mcpUrl,
  onClose,
}: {
  mcpUrl: string;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <DialogPrimitive.Title className="text-base font-medium text-foreground">
          Token created
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="text-xs text-[hsl(var(--warn))]">
          Copy this URL now. It will not be shown again.
        </DialogPrimitive.Description>
      </div>
      <ShowOnceUrl mcpUrl={mcpUrl} />
      <div className="flex items-center justify-end pt-2">
        <Button size="sm" onClick={onClose} data-testid="ive-saved-it">
          I&apos;ve saved it
        </Button>
      </div>
    </div>
  );
}

function messageForError(
  code:
    | "name_required"
    | "name_too_long"
    | "name_taken"
    | "not_found"
    | "expiry_in_past"
    | "internal",
): string {
  switch (code) {
    case "name_required":
      return "Give the token a name.";
    case "name_too_long":
      return "Names must be 64 characters or fewer.";
    case "name_taken":
      return "A token with that name already exists on this connection.";
    case "not_found":
      return "This connection is no longer available. Refresh the page.";
    case "expiry_in_past":
      return "Expiry must be in the future.";
    case "internal":
      return "Something went wrong. Try again or refresh.";
  }
}
