import { GoogleSignIn } from "@/components/auth/google-sign-in";
import { SignUpForm } from "@/components/auth/sign-up-form";
import { BrandLockup } from "@/components/layout/brand-mark";
import { googleAuthEnabled } from "@/lib/social-auth";

// Only allow same-origin relative redirects (no open redirect via ?redirect).
function safeRedirect(value: string | undefined, fallback: string): string {
  return typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//")
    ? value
    : fallback;
}

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  const redirectTo = safeRedirect(redirect, "/signup");
  // Google shows only when this build was given OAuth creds. A Google sign-up
  // lands on the same region picker, which creates the org/customer row.
  const googleEnabled = googleAuthEnabled();
  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border px-10 py-5">
        <BrandLockup />
      </header>
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-[400px]">
          <SignUpForm redirectTo={redirectTo} />
          {googleEnabled && (
            <GoogleSignIn redirectTo={redirectTo} label="Sign up with Google" />
          )}
        </div>
      </div>
    </main>
  );
}
