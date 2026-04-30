import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";

export default async function Landing() {
  const { userId } = await auth();
  if (userId) redirect("/dashboard");

  return (
    <main className="container mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-8 px-4 text-center">
      <div className="space-y-4">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Midplane
        </h1>
        <p className="text-lg text-muted-foreground">
          The safety layer between AI coding agents and your Postgres.
        </p>
      </div>

      <div className="flex gap-3">
        <Link href="/sign-in">
          <Button size="lg">Sign in</Button>
        </Link>
        <Link href="/sign-up">
          <Button size="lg" variant="outline">
            Sign up
          </Button>
        </Link>
      </div>
    </main>
  );
}
