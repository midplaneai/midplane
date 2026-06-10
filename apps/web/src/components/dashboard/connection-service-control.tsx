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
import { useConnectionFreshness } from "@/components/dashboard/freshness-provider";

// Compact Pause/Resume control for the dashboard connection header, sitting
// next to the Live pill — the "close by the indicator" affordance without
// overloading the status dot itself (a click target on a dense row of
// health dots would be a fat-finger outage risk).
//
// Paused state is read live from the freshness provider so this stays in
// lockstep with the pill (same source — see resolveFreshness), falling back
// to the server-rendered initial until the first poll lands. Pause cuts off
// live agent traffic, so it's gated by a confirm; Resume only restores
// service, so it's one click. Both reuse the dashboard's pause/resume
// Server Actions (teardown + audit + PostHog).

export function ConnectionServiceControl({
  connectionId,
  initialPausedAt,
  pauseAction,
  resumeAction,
}: {
  connectionId: string;
  initialPausedAt: Date | null;
  pauseAction: (formData: FormData) => Promise<void>;
  resumeAction: (formData: FormData) => Promise<void>;
}) {
  const live = useConnectionFreshness(connectionId);
  const pausedAt = live ? live.pausedAt : initialPausedAt;

  if (pausedAt != null) {
    return (
      <form action={resumeAction}>
        <input type="hidden" name="id" value={connectionId} />
        <Button type="submit" variant="outline" size="sm">
          Resume
        </Button>
      </form>
    );
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-subtle">
          Pause
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Pause this connection?</AlertDialogTitle>
          <AlertDialogDescription>
            Every agent request is rejected immediately — but the tokens,
            URLs, and policy stay exactly as they are. Resume restores service
            in one click, with the same URLs. Nothing is deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <form action={pauseAction}>
            <input type="hidden" name="id" value={connectionId} />
            <AlertDialogAction type="submit">
              Pause connection
            </AlertDialogAction>
          </form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
