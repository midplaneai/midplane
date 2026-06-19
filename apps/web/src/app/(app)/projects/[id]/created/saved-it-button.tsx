"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { useUnlockCountdown } from "@/hooks/use-unlock-countdown";

import { consumeShowOnceCookie } from "./consume-action";

// Explicit "I've saved it" acknowledgment for the post-create page. The
// one-time URL is left in place (the show-once cookie stays intact) until
// the user clicks this — so a reload or back-nav keeps showing the URL
// instead of dropping to the "already shown" state. The button is gated for
// a few seconds so it can't be clicked through before the URL registers;
// only on click does it clear the cookie and head to the project page,
// where the token list lives.
export function SavedItButton({ projectHref }: { projectHref: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const remaining = useUnlockCountdown(true, 3);
  const locked = remaining > 0;

  return (
    <Button
      size="sm"
      disabled={locked || pending}
      data-testid="saved-it"
      onClick={() =>
        startTransition(async () => {
          await consumeShowOnceCookie();
          router.push(projectHref);
        })
      }
    >
      {locked ? `I've saved it (${remaining})` : "I've saved it — manage tokens"}
    </Button>
  );
}
