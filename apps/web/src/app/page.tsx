import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { BrandLockup } from "@/components/layout/brand-mark";
import { Button } from "@/components/ui/button";

export default async function Landing() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return (
    <main className="relative flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>

      <section className="container mx-auto flex max-w-[760px] flex-1 flex-col items-center justify-center gap-8 px-4 py-16 text-center">
        <div className="space-y-5">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1 text-xs text-muted-foreground">
            <span
              aria-hidden
              className="h-1.5 w-1.5 rounded-full bg-[hsl(var(--allow))] motion-safe:animate-live-pulse"
            />
            Hosted MCP for Postgres · MIT licensed
          </span>
          <h1 className="text-4xl font-semibold tracking-[-0.03em] text-foreground sm:text-5xl">
            The safety layer between AI agents
            <br />
            <span className="text-muted-foreground">and your Postgres.</span>
          </h1>
          <p className="mx-auto max-w-[520px] text-base text-muted-foreground">
            Parse with the actual Postgres parser, walk the AST, evaluate
            policy, write audit. Read-only by default; writes require approval.
            Self-host or hosted.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link href="/sign-up">
            <Button size="lg">Start hosted (free)</Button>
          </Link>
          <Link href="/sign-in">
            <Button size="lg" variant="outline">
              Sign in
            </Button>
          </Link>
          <span className="text-xs text-muted-foreground">
            No credit card · 100K queries/mo free
          </span>
        </div>
      </section>

      <footer className="border-t border-border px-10 py-6 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-5">
          <BrandLockup className="text-xs" />
          <span className="text-muted-foreground">·</span>
          <span>MIT licensed</span>
          <span>·</span>
          <span>v0.1.0</span>
        </div>
      </footer>
    </main>
  );
}
