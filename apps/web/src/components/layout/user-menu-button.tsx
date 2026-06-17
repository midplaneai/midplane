"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

import { authClient, useSession } from "@/lib/auth-client";

// Sidebar footer account control. Shows the signed-in user's name and signs
// them out on click. (Clerk's <UserButton> opened a hosted profile/sign-out
// menu; Better Auth has no hosted UI, so this is the direct sign-out — a
// fuller account menu can land later.)
export function UserMenuButton() {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  if (isPending || !session) return null;
  const name = session.user.name || session.user.email || "Account";

  return (
    <button
      type="button"
      title="Sign out"
      onClick={() =>
        authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              router.push("/");
              router.refresh();
            },
          },
        })
      }
      className="flex w-full items-center gap-2.5 text-sm text-foreground hover:text-foreground"
    >
      <LogOut
        aria-hidden
        className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
        strokeWidth={1.5}
      />
      <span className="min-w-0 flex-1 truncate text-left">{name}</span>
    </button>
  );
}
