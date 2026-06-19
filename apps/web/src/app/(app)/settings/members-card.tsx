"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { createInvite, revokeInvite } from "./members-actions";

export interface MemberView {
  email: string;
  name: string;
  role: string;
  isYou: boolean;
}

export interface PendingInviteView {
  id: string;
  email: string;
  expiresLabel: string;
}

/** Read-only copyable invite link with a copy button. The link is a capability
 *  (anyone who opens it can register as the invited email). The message reflects
 *  the actual outcome: emailed (this build sends and delivery succeeded),
 *  email-failed (this build sends but delivery didn't go through — share the
 *  link), or link-only (self-host, no email — share it out-of-band). */
function InviteLink({
  link,
  emailDelivers,
  emailed,
}: {
  link: string;
  emailDelivers: boolean;
  emailed: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const message = !emailDelivers
    ? "Invite created. Copy this link and share it with your teammate — it works once, for that email, and expires."
    : emailed
      ? "Invite sent — we emailed them the link. You can also copy it below to share directly."
      : "Invite created, but the email didn’t send. Copy this link and share it with them directly.";
  return (
    <div className="space-y-2 border border-border bg-secondary px-4 py-3">
      <p className="text-sm text-foreground">{message}</p>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 break-all border border-border bg-background px-3 py-2 font-mono text-xs text-foreground">
          {link}
        </code>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard.writeText(link).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

// Members + invites for the workspace. The member list renders for everyone who
// can see /settings; the invite form, the copyable link, and revoke render only
// for an owner/admin (canManage). The server actions independently re-check the
// role, so this is UX, not the security boundary.
export function MembersCard({
  members,
  pending,
  canManage,
  seatLimitReached,
  emailDelivers,
}: {
  members: MemberView[];
  pending: PendingInviteView[];
  canManage: boolean;
  /** Plan seat cap is full — show an upgrade CTA instead of the invite form. */
  seatLimitReached: boolean;
  /** This build emails the invite (cloud + Resend) vs. link-only (self-host). */
  emailDelivers: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [emailed, setEmailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviting, startInvite] = useTransition();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLink(null);
    startInvite(async () => {
      const res = await createInvite(email);
      if (res.error) {
        setError(res.error);
        return;
      }
      setLink(res.link ?? null);
      setEmailed(res.emailed ?? false);
      setEmail("");
      router.refresh();
    });
  }

  function onRevoke(id: string) {
    setError(null);
    setRevokingId(id);
    startTransition(async () => {
      const res = await revokeInvite(id);
      setRevokingId(null);
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <ul className="divide-y divide-border border border-border">
        {members.map((m) => (
          <li
            key={m.email}
            className="flex items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">
                {m.name}
                {m.isYou && (
                  <span className="ml-2 text-xs text-subtle">you</span>
                )}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {m.email}
              </p>
            </div>
            <span className="shrink-0 font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
              {m.role}
            </span>
          </li>
        ))}
      </ul>

      {canManage && (
        <div className="space-y-4 border-t border-border pt-6">
          {seatLimitReached ? (
            <div className="space-y-2 border border-border bg-secondary px-4 py-3">
              <p className="text-sm text-foreground">
                You’ve reached your plan’s member limit.
              </p>
              <p className="text-sm text-muted-foreground">
                <Link
                  href="/billing"
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Upgrade your plan
                </Link>{" "}
                to invite more teammates.
              </p>
            </div>
          ) : (
            <form onSubmit={onInvite} className="space-y-3">
              <Label htmlFor="invite-email">Invite a teammate</Label>
              <div className="flex items-stretch gap-2">
                <Input
                  id="invite-email"
                  name="invite-email"
                  type="email"
                  required
                  placeholder="teammate@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="flex-1"
                />
                <Button type="submit" disabled={inviting}>
                  {inviting ? "Creating…" : "Create invite"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {emailDelivers
                  ? "We’ll email them a link to join — tied to their email and expiring in 7 days."
                  : "No email is sent — you’ll get a link to share with them directly."}
              </p>
            </form>
          )}

          {error && (
            <p role="alert" className="text-sm text-[hsl(var(--deny))]">
              {error}
            </p>
          )}

          {link && (
            <InviteLink
              link={link}
              emailDelivers={emailDelivers}
              emailed={emailed}
            />
          )}

          {pending.length > 0 && (
            <div className="space-y-2">
              <p className="font-mono text-[11.5px] lowercase tracking-[0.04em] text-subtle">
                pending invites
              </p>
              <ul className="divide-y divide-border border border-border">
                {pending.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-foreground">
                        {inv.email}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {inv.expiresLabel}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isPending && revokingId === inv.id}
                      onClick={() => onRevoke(inv.id)}
                    >
                      {isPending && revokingId === inv.id
                        ? "Revoking…"
                        : "Revoke"}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
