"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { DeadEndCard } from "@/components/ui/dead-end-card";
import { SUPPORT_EMAIL, supportErrorMailto } from "@/lib/support";
import { cn } from "@/lib/utils";

// Shared error-boundary body for app/error.tsx (root) and app/(app)/error.tsx
// (inside the shell). One component so the two surfaces can't drift.
//
// The support mailto carries host/path/time — client-only values. It's
// computed in an effect: the SSR'd fallback has no window, and production
// React does not reconcile attribute mismatches on hydration, so an
// href computed during render would keep the degraded server value. The
// pre-hydration href is the bare mailbox — never wrong, just less detailed.
// The address also appears as selectable text for users with no mailto
// handler (managed desktops, kiosks) so the error page can't become the
// dead end this component exists to prevent.
export function ErrorFallback({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server-side errors reach PostHog via onRequestError; client render
    // errors have no server capture, so at least leave a console trace.
    console.error(error);
  }, [error]);

  const [mailto, setMailto] = useState(`mailto:${SUPPORT_EMAIL}`);
  useEffect(() => {
    setMailto(supportErrorMailto(error.digest, "client-error"));
  }, [error.digest]);

  return (
    <DeadEndCard
      label="error"
      title="Something went wrong"
      description={
        <>
          {error.digest ? (
            <>
              The error was recorded with reference{" "}
              <span className="font-mono">{error.digest}</span>.{" "}
            </>
          ) : null}
          Try again — if it keeps happening, email us at{" "}
          <span className="text-foreground">{SUPPORT_EMAIL}</span> and
          we&apos;ll dig in.
        </>
      }
      actions={
        <>
          <Button size="sm" onClick={reset}>
            Try again
          </Button>
          <Link
            href="/dashboard"
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "text-foreground",
            )}
          >
            Go to dashboard
          </Link>
          <a
            href={mailto}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "text-foreground",
            )}
          >
            Email support
          </a>
        </>
      }
    />
  );
}
