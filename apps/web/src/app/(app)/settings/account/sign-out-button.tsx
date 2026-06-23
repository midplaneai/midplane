"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { authClient } from "@/lib/auth-client";

// On-page sign-out, the deliberate twin of the sidebar account menu's "Sign
// out". Lives in the account page so the action is reachable here too (and not
// only behind the footer menu).
export function SignOutButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await authClient.signOut();
          router.push("/");
          router.refresh();
        })
      }
      className="inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
    >
      <LogOut aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
