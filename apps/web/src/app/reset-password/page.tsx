import Link from "next/link";

import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { BrandLockup } from "@/components/layout/brand-mark";

// Landing page for the reset link emailed by Better Auth. The link points at
// Better Auth's own /api/auth/reset-password/:token endpoint, which verifies the
// token isn't expired then redirects here with ?token=<valid> — or, if it's
// stale/used, with ?error=INVALID_TOKEN. Always the regional origin (the email
// was generated with that region's BETTER_AUTH_URL), so no apex handling.

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  const invalid = Boolean(error) || !token;

  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px]">
          {invalid ? (
            <>
              <div className="mb-8 space-y-2">
                <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
                  Link expired
                </h1>
                <p className="text-sm text-muted-foreground">
                  This password reset link is invalid or has expired. Request a
                  new one to continue.
                </p>
              </div>
              <p className="text-sm text-muted-foreground">
                <Link
                  href="/forgot"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Request a new link
                </Link>
              </p>
            </>
          ) : (
            <ResetPasswordForm token={token!} />
          )}
        </div>
      </div>
    </main>
  );
}
