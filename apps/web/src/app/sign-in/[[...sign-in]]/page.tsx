import { GoogleSignIn } from "@/components/auth/google-sign-in";
import { SignInForm } from "@/components/auth/sign-in-form";
import { SsoSignIn } from "@/components/auth/sso-sign-in";
import { BrandLockup } from "@/components/layout/brand-mark";
import { eeBuildEnabled } from "@/lib/plan";
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
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  const redirectTo = safeRedirect(redirect, "/dashboard");
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
          <SignInForm redirectTo={redirectTo} />
          {googleEnabled && <GoogleSignIn redirectTo={redirectTo} />}
          {ssoEnabled && <SsoSignIn redirectTo={redirectTo} />}
        </div>
      </div>
    </main>
  );
}
