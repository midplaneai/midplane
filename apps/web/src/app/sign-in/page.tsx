import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { GoogleSignIn } from "@/components/auth/google-sign-in";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SsoSignIn } from "@/components/auth/sso-sign-in";
import { BrandLockup } from "@/components/layout/brand-mark";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { eeBuildEnabled } from "@/lib/plan";
import {
  APEX_HOST,
  REGION_HOST,
  signEmailHint,
  verifyEmailHint,
} from "@/lib/region-routing";
import { isSelfHost } from "@/lib/self-host";
import { resolveSignInRegionOnApex } from "@/lib/signin-routing";
import { googleAuthEnabled } from "@/lib/social-auth";

// Only allow same-origin relative redirects (no open redirect via ?redirect).
function safeRedirect(value: string | undefined, fallback: string): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
    ? value
    : fallback;
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string; e?: string }>;
}) {
  const { redirect: redirectParam, e } = await searchParams;
  const redirectTo = safeRedirect(redirectParam, "/dashboard");

  // Apex (cloud): we can't know which regional auth DB owns the account, and the
  // apex is the EU app — a US user's password would just fail here. So the apex
  // /sign-in is a pure ROUTER: collect the email, resolve the region (own EU-DB
  // hit ⇒ EU, miss ⇒ US by elimination), redirect to that regional /sign-in with
  // a signed email hint to prefill. Middleware already sends apex users WITH a
  // region cookie straight to their subdomain, so this only renders for a cold
  // browser (the exact returning-user cookie-miss this fixes).
  const host = (await headers()).get("host");
  if (!isSelfHost() && host === APEX_HOST) {
    return <ApexSignInRouter redirectTo={redirectTo} />;
  }

  // Regional / dev / self-host: the real email+password form. Prefill the email
  // when the apex router redirected here with a valid signed hint.
  const initialEmail = (await verifyEmailHint(e)) ?? "";
  // SSO is an ee build feature; the "Continue with SSO" entry shows only when
  // this build ships it. (Pre-auth there's no org to resolve a plan from, so the
  // per-plan entitlement is enforced later — at provider sign-in, an org without
  // an SSO provider simply has no match.)
  const ssoEnabled = eeBuildEnabled();
  // Google shows only when this build was given OAuth creds (self-host / keyless
  // dev get none unless they set them). Same gate as the server auth config.
  const googleEnabled = googleAuthEnabled();
  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px]">
          <SignInForm
            redirectTo={redirectTo}
            initialEmail={initialEmail}
            // Cloud: "Create an account" goes through the region picker (region
            // is permanent). Self-host has no picker — link straight to /sign-up.
            createAccountHref={isSelfHost() ? "/sign-up" : "/signup"}
          />
          {googleEnabled && <GoogleSignIn redirectTo={redirectTo} />}
          {ssoEnabled && <SsoSignIn redirectTo={redirectTo} />}
        </div>
      </div>
    </main>
  );
}

// Apex router action: resolve the region for the typed email and redirect to
// the owning regional /sign-in. Reads only this (EU) app's DB — a miss means the
// other region (two-region elimination; see lib/signin-routing). The email rides
// in a signed, short-lived hint, not plaintext in the URL.
async function routeSignIn(formData: FormData): Promise<void> {
  "use server";
  const email = String(formData.get("email") ?? "").trim();
  const redirectTo = safeRedirect(
    String(formData.get("redirect") ?? ""),
    "/dashboard",
  );
  if (!email) redirect("/sign-in");
  const region = await resolveSignInRegionOnApex(email);
  const params = new URLSearchParams({ e: await signEmailHint(email) });
  if (redirectTo !== "/dashboard") params.set("redirect", redirectTo);
  redirect(`https://${REGION_HOST[region]}/sign-in?${params.toString()}`);
}

function ApexSignInRouter({ redirectTo }: { redirectTo: string }) {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 space-y-2">
            <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
              Sign in
            </h1>
            <p className="text-sm text-muted-foreground">
              Enter your email to continue.
            </p>
          </div>
          <form action={routeSignIn} className="space-y-5">
            <input type="hidden" name="redirect" value={redirectTo} />
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
          <p className="mt-6 text-sm text-muted-foreground">
            New to Midplane?{" "}
            <Link
              href="/signup"
              className="font-medium text-foreground underline underline-offset-2"
            >
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
