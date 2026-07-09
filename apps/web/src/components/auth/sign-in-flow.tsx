"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { stampRegionCookie } from "@/lib/region-cookie-action";
import type { SignInMethods } from "@/lib/signin-routing";

import { GoogleSignIn } from "./google-sign-in";
import { discoverSignInMethods } from "./signin-discovery";
import { SsoSignIn } from "./sso-sign-in";

// Identifier-first sign-in (Better Auth has no hosted UI). Instead of showing a
// password field, a Google button and an SSO field all at once — which asks a
// Google-signup user for a password they never set — we resolve the email
// first, then render ONLY the methods that account actually has.
//
// Two entry points converge here:
//  - The apex router already collected the email and forwarded it as a signed
//    hint; the server verified it and discovered the methods, passing
//    initialEmail + initialMethods. We open straight on the method step.
//  - A cold visit to a regional /sign-in (no hint) opens on the email step and
//    discovers via the server action after the user types their email.
//
// Discovery is best-effort: a null/unknown result falls back to the generic
// combined form (password + Google), which never asserts whether an account
// exists — the safe default that also covers genuinely new emails.
export function SignInFlow({
  redirectTo = "/dashboard",
  initialEmail = "",
  initialMethods = null,
  googleEnabled = false,
  ssoEnabled = false,
  resetEnabled = false,
  createAccountHref = "/signup",
}: {
  redirectTo?: string;
  initialEmail?: string;
  initialMethods?: SignInMethods | null;
  googleEnabled?: boolean;
  ssoEnabled?: boolean;
  /** Whether this build can send a password-reset email (cloud + Resend). */
  resetEnabled?: boolean;
  createAccountHref?: string;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "method">(
    initialEmail ? "method" : "email",
  );
  const [email, setEmail] = useState(initialEmail);
  const [methods, setMethods] = useState<SignInMethods | null>(initialMethods);
  const [password, setPassword] = useState("");
  const [revealPassword, setRevealPassword] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resetPending, setResetPending] = useState(false);

  // --- email step: resolve which methods this account has, then advance ---
  async function onEmailSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const found = await discoverSignInMethods(email);
    setMethods(found);
    setPending(false);
    setStep("method");
  }

  function changeEmail() {
    setStep("email");
    setMethods(null);
    setPassword("");
    setRevealPassword(false);
    setResetSent(false);
    setError(null);
  }

  // --- method step: email/password ---
  async function onPasswordSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error: signInError } = await authClient.signIn.email({
      email,
      password,
    });
    if (signInError) {
      setError(
        signInError.message ??
          "Could not sign in. Check your email and password.",
      );
      setPending(false);
      return;
    }
    // Region-stick this browser: a successful sign-in means this region owns the
    // account, so the next apex visit routes straight here. Best-effort.
    await stampRegionCookie();
    router.push(redirectTo);
    router.refresh();
  }

  // --- method step: inline "forgot password" (email + region already known) ---
  async function onForgot() {
    setError(null);
    setResetPending(true);
    const { error: resetError } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setResetPending(false);
    if (resetError) {
      setError(resetError.message ?? "Could not send a reset email.");
      return;
    }
    // requestPasswordReset returns success whether or not the email exists, so
    // the confirmation is deliberately non-committal about existence.
    setResetSent(true);
  }

  if (step === "email") {
    return (
      <div className="w-full max-w-[400px]">
        <Header subtitle="Enter your email to continue." />
        <form onSubmit={onEmailSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          <Button
            type="submit"
            className="w-full"
            size="lg"
            arrow
            disabled={pending}
          >
            {pending ? "Checking…" : "Continue"}
          </Button>
        </form>
        <CreateAccount href={createAccountHref} />
      </div>
    );
  }

  // Method step. Which affordances to show for this account. Derive plain
  // booleans up front (null/failed discovery collapses to "unknown") so the
  // logic below never has to re-narrow methods.
  const known = methods?.exists ?? false;
  const hasPassword = methods?.hasPassword ?? false;
  const hasGoogle = methods?.hasGoogle ?? false;
  const generic = !known; // unknown email / discovery failed → generic form
  let showPassword = generic || hasPassword;
  let showGoogle = googleEnabled && (generic || hasGoogle);
  // Account exists but has no method usable here (e.g. SSO-only): don't dead-end
  // — fall back to the generic combined form.
  if (known && !hasPassword && !(googleEnabled && hasGoogle)) {
    showPassword = true;
    showGoogle = googleEnabled;
  }
  const googleOnly = known && hasGoogle && !hasPassword && googleEnabled;

  // A Google-only account hides the password form behind an explicit opt-in, so
  // the page reads "Continue with Google", not "type a password you never set".
  const passwordVisible = revealPassword || (!googleOnly && showPassword);
  const googleVisible = googleOnly || showGoogle;
  const showForgot = resetEnabled && passwordVisible;

  if (resetSent) {
    return (
      <div className="w-full max-w-[400px]">
        <Header subtitle="Check your email." />
        <p className="text-sm text-muted-foreground">
          If an account exists for <strong className="text-foreground">{email}</strong>,
          we&apos;ve sent a link to reset your password. It expires in 1 hour.
        </p>
        <button
          type="button"
          onClick={changeEmail}
          className="mt-6 text-sm font-medium text-foreground underline underline-offset-2"
        >
          Back to sign in
        </button>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[400px]">
      <Header subtitle="Welcome back to Midplane." />

      {passwordVisible ? (
        <form onSubmit={onPasswordSubmit} className="space-y-5">
          <EmailRow email={email} onChange={changeEmail} />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              {showForgot && (
                <button
                  type="button"
                  onClick={onForgot}
                  disabled={resetPending}
                  className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
                >
                  {resetPending ? "Sending…" : "Forgot password?"}
                </button>
              )}
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {googleOnly && revealPassword && (
              <p className="text-xs text-muted-foreground">
                You signed up with Google. If you&apos;ve set a password, enter
                it — otherwise use “Forgot password?” to set one.
              </p>
            )}
          </div>
          {error && <ErrorText>{error}</ErrorText>}
          <Button
            type="submit"
            className="w-full"
            size="lg"
            arrow
            disabled={pending}
          >
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      ) : (
        <div className="space-y-4">
          <EmailRow email={email} onChange={changeEmail} />
          {error && <ErrorText>{error}</ErrorText>}
        </div>
      )}

      {googleVisible && (
        <GoogleSignIn
          redirectTo={redirectTo}
          divider={passwordVisible}
          label="Continue with Google"
        />
      )}

      {googleOnly && !revealPassword && (
        <button
          type="button"
          onClick={() => setRevealPassword(true)}
          className="mt-4 w-full text-center text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Use a password instead
        </button>
      )}

      {ssoEnabled && <SsoSignIn redirectTo={redirectTo} />}

      <CreateAccount href={createAccountHref} />
    </div>
  );
}

function Header({ subtitle }: { subtitle: string }) {
  return (
    <div className="mb-8 space-y-2">
      <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
        Sign in
      </h1>
      <p className="text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

// The resolved email, shown read-only with a "Change" affordance. Kept inside
// the password <form> and marked autoComplete="username" so password managers
// associate the saved credential with this account.
function EmailRow({
  email,
  onChange,
}: {
  email: string;
  onChange: () => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor="email-display">Email</Label>
      <div className="flex items-center gap-2">
        <Input
          id="email-display"
          name="email"
          type="email"
          autoComplete="username"
          value={email}
          readOnly
          className="flex-1"
        />
        <Button type="button" variant="ghost" size="sm" onClick={onChange}>
          Change
        </Button>
      </div>
    </div>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-sm text-[hsl(var(--deny))]">
      {children}
    </p>
  );
}

function CreateAccount({ href }: { href: string }) {
  return (
    <p className="mt-6 text-sm text-muted-foreground">
      New to Midplane?{" "}
      <Link
        href={href}
        className="font-medium text-foreground underline underline-offset-2"
      >
        Create an account
      </Link>
    </p>
  );
}
