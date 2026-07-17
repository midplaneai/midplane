import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { DeadEndCard } from "@/components/ui/dead-end-card";
import { isSelfHost } from "@/lib/self-host";
import { GITHUB_ISSUES_URL, SUPPORT_EMAIL, supportMailto } from "@/lib/support";
import { cn } from "@/lib/utils";

// App-wide 404 — a stale link should offer a way onward, not a dead end.
// Server component, so it can branch on the build directly: self-host routes
// to GitHub issues (matching helpLinksFor — a self-host install shouldn't
// advertise a cloud mailbox that can't see its instance); cloud gets the
// support mailto with the address visible as text for users without a
// mailto handler.
export default function NotFound() {
  const selfHost = isSelfHost();
  return (
    <DeadEndCard
      label="404"
      title="This page doesn't exist"
      description={
        selfHost ? (
          <>
            The link may be stale, or the resource may have been deleted. If
            you expected something here, open a GitHub issue.
          </>
        ) : (
          <>
            The link may be stale, or the resource may have been deleted. If
            you expected something here, email us at{" "}
            <span className="text-foreground">{SUPPORT_EMAIL}</span>.
          </>
        )
      }
      actions={
        <>
          <Link href="/dashboard" className={buttonVariants({ size: "sm" })}>
            Go to dashboard
          </Link>
          {selfHost ? (
            <a
              href={GITHUB_ISSUES_URL}
              target="_blank"
              rel="noreferrer"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "text-foreground",
              )}
            >
              GitHub issues
            </a>
          ) : (
            <a
              href={supportMailto({ subject: "Unexpected 404 in the app" })}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "text-foreground",
              )}
            >
              Email support
            </a>
          )}
        </>
      }
    />
  );
}
