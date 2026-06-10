"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Plus, X } from "lucide-react";
import { useId, useState, useTransition } from "react";

import { ConnectAgentGuide } from "@/components/connections/connect-agent-guide";
import { ShowOnceUrl } from "@/components/show-once-url";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUnlockCountdown } from "@/hooks/use-unlock-countdown";
import { cn } from "@/lib/utils";

// Create-token modal. Triggered by the [+ New token] button in the
// Tokens list panel header. Three surfaces inside the same modal:
//   1. The form (name + expiry).
//   2. After a successful submit, the show-once URL surface — the
//      plaintext is in React state, never round-tripped through a
//      cookie/session (unlike the connection-create flow which has to
//      cross a redirect boundary). The "I've saved it" button discards
//      the plaintext from state and closes the modal.
//   3. The limit panel (when `limitReached` is set) — shown in place of
//      the form so a capped user sees the limit + upgrade/revoke paths on
//      open instead of after submitting. The trigger keeps its normal
//      label; we explain on open rather than swapping in a billing button.
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
  | { ok: false; error: "plan_limit"; limit: number; upgradeUrl: string }
>;

interface CreateTokenModalProps {
  connectionId: string;
  action: CreateTokenAction;
  /** Used to label the MCP server key in the setup snippets. */
  connectionName?: string | null;
  /** Region host for the setup snippets' example URL. */
  region?: string | null;
  /** Override the trigger button label (e.g. "Connect your first agent"). */
  triggerLabel?: string;
  /** When the org is already at its token cap, the modal opens to a limit
   *  panel (Upgrade + "revoke one to free a slot") instead of the form — so
   *  the user sees the limit before filling it in, not after submitting. The
   *  trigger keeps its normal "Connect an agent" label (we honor the intent
   *  and explain on open, rather than swapping in a billing button). The cap
   *  is org-wide, so `limit` reads "across all your connections". createToken
   *  still enforces under a lock, and the in-form plan_limit branch below
   *  stays as the backstop for a race (another tab/device minting). */
  limitReached?: { limit: number; plan: string; upgradeUrl: string };
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
  connectionName,
  region,
  triggerLabel = "Connect an agent",
  limitReached,
}: CreateTokenModalProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<string>(DEFAULT_EXPIRY);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Set alongside `error` only when the failure is a plan cap, so the form
  // can render an upgrade link next to the message (a dead-end "limit
  // reached" with no action would be a UX trap).
  const [upgradeUrl, setUpgradeUrl] = useState<string | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string | null>(null);
  const nameId = useId();
  const expiryId = useId();

  // Once the URL is on screen the modal becomes un-dismissable by accident:
  // outside-click and Escape are swallowed (see the Content handlers) and the
  // close affordances are gated behind a short countdown, so the plaintext
  // can't be clicked through before it has been copied. The form state (no
  // URL yet) stays freely dismissable — there's nothing to lose there.
  const reveal = mcpUrl !== null;
  const remaining = useUnlockCountdown(reveal, 3);
  const locked = reveal && remaining > 0;

  function reset() {
    setName("");
    setExpiry(DEFAULT_EXPIRY);
    setError(null);
    setUpgradeUrl(null);
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
    setUpgradeUrl(null);

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
      if (result.error === "plan_limit") {
        setError(
          `You've reached your plan's token limit (${result.limit}).`,
        );
        setUpgradeUrl(result.upgradeUrl);
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
          {triggerLabel}
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
          // While the URL is revealed, swallow outside-click and Escape so
          // the modal can't be dismissed (and the plaintext silently lost)
          // by accident. The form state has nothing to lose, so it closes
          // normally.
          onInteractOutside={(e) => {
            if (reveal) e.preventDefault();
          }}
          onEscapeKeyDown={(e) => {
            if (reveal) e.preventDefault();
          }}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full -translate-x-1/2 -translate-y-1/2",
            mcpUrl ? "max-w-xl" : "max-w-lg",
            "max-h-[90vh] overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-lg",
            "motion-safe:duration-200 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=closed]:animate-out",
            "motion-safe:data-[state=closed]:fade-out-0 motion-safe:data-[state=open]:fade-in-0",
          )}
        >
          <DialogPrimitive.Close
            disabled={locked}
            className={cn(
              "absolute right-4 top-4 rounded-sm text-subtle transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
              locked && "pointer-events-none opacity-40",
            )}
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </DialogPrimitive.Close>
          {limitReached ? (
            <LimitPanel
              limit={limitReached.limit}
              plan={limitReached.plan}
              upgradeUrl={limitReached.upgradeUrl}
              onClose={() => handleOpenChange(false)}
            />
          ) : mcpUrl ? (
            <SuccessPanel
              mcpUrl={mcpUrl}
              connectionName={connectionName}
              region={region}
              locked={locked}
              remaining={remaining}
              onClose={() => handleOpenChange(false)}
            />
          ) : (
            <form onSubmit={onSubmit} className="space-y-5">
              <div className="space-y-1">
                <DialogPrimitive.Title className="text-base font-medium text-foreground">
                  Connect an agent
                </DialogPrimitive.Title>
                <DialogPrimitive.Description className="text-xs text-muted-foreground">
                  We&apos;ll mint this agent its own MCP server URL. Name it for
                  the laptop, CI job, or service it&apos;s for — the name shows
                  next to the last-used timestamp here.
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
                  {upgradeUrl ? (
                    <>
                      {" "}
                      <a
                        href={upgradeUrl}
                        className="font-medium text-foreground underline underline-offset-2"
                      >
                        Upgrade your plan
                      </a>
                      .
                    </>
                  ) : null}
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
                  {pending ? "Connecting…" : "Connect agent"}
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
  connectionName,
  region,
  locked,
  remaining,
  onClose,
}: {
  mcpUrl: string;
  connectionName?: string | null;
  region?: string | null;
  /** True while the dismiss countdown is still running. */
  locked: boolean;
  /** Seconds left on that countdown (for the button label). */
  remaining: number;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <DialogPrimitive.Title className="text-base font-medium text-foreground">
          Agent connected — copy your URL
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="text-xs text-[hsl(var(--warn))]">
          This is the only time you&apos;ll see the full URL. We store only a
          hashed digest. Copy it before you close this.
        </DialogPrimitive.Description>
      </div>
      <ShowOnceUrl mcpUrl={mcpUrl} />
      <ConnectAgentGuide
        connectionName={connectionName}
        region={region}
        mcpUrl={mcpUrl}
      />
      <div className="flex items-center justify-end pt-2">
        <Button
          size="sm"
          onClick={onClose}
          disabled={locked}
          data-testid="ive-saved-it"
        >
          {locked ? `I've saved it (${remaining})` : "I've saved it"}
        </Button>
      </div>
    </div>
  );
}

// Shown in place of the form when the org is already at its token cap.
// Names the cap, then offers BOTH ways forward — upgrade, or revoke an agent
// from the list behind the modal to free a slot — so the paid path isn't the
// only visible exit. Mirrors the /connections/new at-limit surface.
function LimitPanel({
  limit,
  plan,
  upgradeUrl,
  onClose,
}: {
  limit: number;
  plan: string;
  upgradeUrl: string;
  onClose: () => void;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <DialogPrimitive.Title className="text-base font-medium text-foreground">
          You&apos;ve reached your plan&apos;s agent limit
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="text-xs text-muted-foreground">
          The {plan} plan includes {limit} agent{" "}
          {limit === 1 ? "token" : "tokens"} across all your connections.
          Upgrade for more, or revoke an agent you no longer use to free a
          slot.
        </DialogPrimitive.Description>
      </div>
      <div className="flex items-center justify-end gap-2 pt-2">
        <Button type="button" variant="outline" size="sm" onClick={onClose}>
          Close
        </Button>
        <a href={upgradeUrl}>
          <Button size="sm">Upgrade your plan</Button>
        </a>
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
