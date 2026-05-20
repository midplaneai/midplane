"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { User } from "lucide-react";

export function UserMenuButton() {
  const { user, isLoaded } = useUser();
  const clerk = useClerk();
  if (!isLoaded || !user) return null;
  const name =
    user.fullName ?? user.primaryEmailAddress?.emailAddress ?? "Account";

  return (
    <button
      type="button"
      onClick={() => clerk.openUserProfile()}
      className="flex w-full items-center gap-2.5 text-sm text-foreground hover:text-foreground"
    >
      <User
        aria-hidden
        className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
        strokeWidth={1.5}
      />
      <span className="min-w-0 flex-1 truncate text-left">{name}</span>
    </button>
  );
}
