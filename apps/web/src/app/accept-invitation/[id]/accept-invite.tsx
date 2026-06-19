"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

import { acceptInvite } from "./actions";

// The interactive half of the invite-accept landing. Three states, decided by
// the session the server resolved:
//   - signed in AS the invited email  → one-click accept.
//   - signed in as SOMEONE ELSE       → must sign out (the invite is bound to a
//     specific email; acceptInvitation would reject a mismatched session).
//   - not signed in                   → sign up with the invited email (locked),
//     then accept in the same flow. The self-host signup gate lets this through
//     precisely because a pending invite exists for this email.
export function AcceptInvite({
  invitationId,
  email,
  orgName,
  signedInEmail,
}: {
  invitationId: string;
  email: string;
  orgName: string;
  signedInEmail: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const matches =
    signedInEmail != null &&
    signedInEmail.toLowerCase() === email.toLowerCase();

  async function accept(): Promise<void> {
    // Server action (not authClient): it accepts AND, in the cloud, pins the
    // home-region cookie to this regional app so the new user routes correctly
    // afterward (see ./actions.ts).
    const { error: acceptError } = await acceptInvite(invitationId);
    if (acceptError) {
      throw new Error(acceptError);
    }
    router.push("/dashboard");
    router.refresh();
  }

  // Branch 1: already signed in as the invited email.
  async function onAccept(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      await accept();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPending(false);
    }
  }

  // Branch 3: sign up with the invited email, then accept.
  async function onSignUpAndAccept(
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    e.preventDefault();
    setError(null);
    setPending(true);
    const { error: signUpError } = await authClient.signUp.email({
      name,
      email,
      password,
    });
    if (signUpError) {
      setError(signUpError.message ?? "Could not create your account.");
      setPending(false);
      return;
    }
    try {
      await accept();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setPending(false);
    }
  }

  async function onSignOut(): Promise<void> {
    setError(null);
    setPending(true);
    await authClient.signOut();
    router.refresh();
    setPending(false);
  }

  return (
    <div className="w-full max-w-[400px]">
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-[-0.025em] text-foreground">
          Join {orgName}
        </h1>
        <p className="text-sm text-muted-foreground">
          You’ve been invited to{" "}
          <strong className="font-medium text-foreground">{orgName}</strong> on
          Midplane.
        </p>
      </div>

      {matches ? (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">
            Signed in as{" "}
            <span className="font-mono text-xs text-foreground">{email}</span>.
            Accept to join the workspace.
          </p>
          {error && (
            <p role="alert" className="text-sm text-[hsl(var(--deny))]">
              {error}
            </p>
          )}
          <Button
            type="button"
            className="w-full"
            size="lg"
            arrow
            disabled={pending}
            onClick={onAccept}
          >
            {pending ? "Joining…" : "Accept invitation"}
          </Button>
        </div>
      ) : signedInEmail ? (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground">
            This invite is for{" "}
            <span className="font-mono text-xs text-foreground">{email}</span>,
            but you’re signed in as{" "}
            <span className="font-mono text-xs text-foreground">
              {signedInEmail}
            </span>
            . Sign out to accept it with the invited email.
          </p>
          {error && (
            <p role="alert" className="text-sm text-[hsl(var(--deny))]">
              {error}
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            size="lg"
            disabled={pending}
            onClick={onSignOut}
          >
            {pending ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      ) : (
        <form onSubmit={onSignUpAndAccept} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" value={email} readOnly />
          </div>
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
            disabled={pending}
          >
            {pending ? "Joining…" : "Create account & join"}
          </Button>
        </form>
      )}
    </div>
  );
}
