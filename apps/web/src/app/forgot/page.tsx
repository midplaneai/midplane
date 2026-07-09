import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { BrandLockup } from "@/components/layout/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isEmailConfigured } from "@/lib/email";
import {
  APEX_HOST,
  REGION_HOST,
  signEmailHint,
  verifyEmailHint,
} from "@/lib/region-routing";
import { isSelfHost } from "@/lib/self-host";
import { resolveSignInRegionOnApex } from "@/lib/signin-routing";

// "Forgot password" entry. Mirrors /sign-in's region topology: a reset is
// region-resident (the token + credential live in one regional DB), so the apex
// can't run it — it ROUTES to the owning region first, exactly like sign-in.
// The common path never lands here (the sign-in method step resets inline once
// the email + region are known); this page backs direct visits and the "request
// another link" case.

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ e?: string }>;
}) {
  const { e } = await searchParams;

  const host = (await headers()).get("host");
  if (!isSelfHost() && host === APEX_HOST) {
    return <ForgotRouter />;
  }

  const initialEmail = (await verifyEmailHint(e)) ?? "";
  return (
    <Shell>
      {isEmailConfigured() ? (
        <ForgotPasswordForm initialEmail={initialEmail} />
      ) : (
        <Unavailable />
      )}
    </Shell>
  );
}

// Apex router: resolve the region for the typed email and redirect to that
// region's /forgot so requestPasswordReset runs against the DB that owns the
// account. Same non-leaky elimination as sign-in — an unknown email routes to
// the other region too, and requestPasswordReset is uniform either way.
async function routeForgot(formData: FormData): Promise<void> {
  "use server";
  const email = String(formData.get("email") ?? "").trim();
  if (!email) redirect("/forgot");
  const region = await resolveSignInRegionOnApex(email);
  const params = new URLSearchParams({ e: await signEmailHint(email) });
  redirect(`https://${REGION_HOST[region]}/forgot?${params.toString()}`);
}

function ForgotRouter() {
  return (
    <Shell>
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
          Reset your password
        </h1>
        <p className="text-sm text-muted-foreground">
          Enter your email and we&apos;ll send a reset link.
        </p>
      </div>
      <form action={routeForgot} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
          />
        </div>
        <Button type="submit" className="w-full" size="lg" arrow>
          Continue
        </Button>
      </form>
      <BackToSignIn />
    </Shell>
  );
}

function Unavailable() {
  return (
    <>
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
          Reset your password
        </h1>
        <p className="text-sm text-muted-foreground">
          Password reset by email isn&apos;t available on this instance. Contact
          your administrator to reset your password.
        </p>
      </div>
      <BackToSignIn />
    </>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px]">{children}</div>
      </div>
    </main>
  );
}

function BackToSignIn() {
  return (
    <p className="mt-6 text-sm text-muted-foreground">
      <Link
        href="/sign-in"
        className="font-medium text-foreground underline underline-offset-2"
      >
        Back to sign in
      </Link>
    </p>
  );
}
