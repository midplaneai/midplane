"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { TurnstileWidget } from "@/components/auth/turnstile-widget";

// Email/password sign-up on the design-system primitives.
//
// Two server-side conditionals shape this form, and BOTH are detected from the
// response rather than assumed, because each is independently on in cloud and
// off in self-host / keyless dev (lib/email.ts, lib/captcha.ts):
//
//  - Verification required → sign-up returns `token: null` (no session). The
//    user is NOT signed in, so the old unconditional router.push(redirectTo)
//    would land on an authenticated route and bounce straight back to sign-in.
//    We show "check your inbox" instead, and pass callbackURL so that following
//    the link auto-signs-in (autoSignInAfterVerification) and drops them into
//    the same onboarding step the direct path would have.
//  - Verification not required → `token` present, session live, original
//    behavior: straight to onboarding.
const CAPTCHA_ACTION = "signup";

export function SignUpForm({
  redirectTo = "/signup",
  captchaSiteKey = null,
}: {
  redirectTo?: string;
  /** Resolved server-side by captchaSiteKey() and passed down; null = captcha
   *  off. Never read from process.env in this client component — see
   *  lib/captcha.ts. */
  captchaSiteKey?: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const [awaitingVerification, setAwaitingVerification] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sending" | "sent">(
    "idle",
  );

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);

    const { data, error } = await authClient.signUp.email(
      {
        name,
        email,
        password,
        // Where verification lands them. Ignored when verification is off.
        callbackURL: redirectTo,
      },
      captchaToken
        ? { headers: { "x-captcha-response": captchaToken } }
        : undefined,
    );

    if (error) {
      setError(error.message ?? "Could not create your account.");
      setCaptchaToken(null); // single-use; force a fresh challenge on retry
      setPending(false);
      return;
    }

    // No session token => the server requires verification before sign-in.
    if (!data?.token) {
      setAwaitingVerification(true);
      setPending(false);
      return;
    }

    router.push(redirectTo);
    router.refresh();
  }

  async function onResend() {
    setResendState("sending");
    // Deliberately ignores the result: this endpoint answers uniformly whether
    // or not the address exists, and surfacing a distinguishable failure here
    // would undo that. "Sent" means "we asked", which is all the caller can
    // honestly be told.
    await authClient
      .sendVerificationEmail({ email, callbackURL: redirectTo })
      .catch(() => {});
    setResendState("sent");
  }

  if (awaitingVerification) {
    return (
      <div className="w-full max-w-[400px]">
        <div className="mb-8 space-y-2">
          <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
            Check your inbox
          </h1>
          <p className="text-sm text-muted-foreground">
            We sent a verification link to{" "}
            <span className="text-foreground">{email}</span>. Open it to finish
            setting up your account.
          </p>
        </div>
        <div className="space-y-4">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            size="lg"
            onClick={onResend}
            disabled={resendState !== "idle"}
          >
            {resendState === "sending"
              ? "Sending…"
              : resendState === "sent"
                ? "Sent — check your inbox"
                : "Resend the link"}
          </Button>
          <p className="text-xs text-muted-foreground">
            Wrong address, or didn&apos;t get it? Check spam first, then{" "}
            <Link
              href="/sign-up"
              className="font-medium text-foreground underline underline-offset-2"
            >
              start over
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[400px]">
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
          Create your account
        </h1>
        <p className="text-sm text-muted-foreground">
          Safe Postgres for your team&apos;s AI agents.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">At least 8 characters.</p>
        </div>

        <TurnstileWidget
          siteKey={captchaSiteKey}
          action={CAPTCHA_ACTION}
          onToken={setCaptchaToken}
        />

        {error && (
          <p role="alert" className="text-sm text-[hsl(var(--deny))]">
            {error}
          </p>
        )}

        <Button
          type="submit"
          className="w-full"
          size="lg"
          arrow
          // When the challenge is configured, block submit until it resolves —
          // otherwise the POST is a guaranteed server-side rejection and the
          // user just sees an opaque failure.
          disabled={pending || (Boolean(captchaSiteKey) && !captchaToken)}
        >
          {pending ? "Creating account…" : "Create account"}
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          href="/sign-in"
          className="font-medium text-foreground underline underline-offset-2"
        >
          Sign in
        </Link>
      </p>
    </div>
  );
}
