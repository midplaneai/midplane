"use client";

import { ChevronsUpDown, LogOut, Settings, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient, useSession } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

// Sidebar/topbar account control. Clicking the trigger opens a menu — it does
// NOT sign out. (The old button signed out on any click, so a single click on
// your own name logged you out, which surprised people. Better Auth has no
// hosted account UI, so this is our menu: identity at the top, an Account page
// link, and sign-out as an explicit, last, destructive item.)
//
// Two variants share one menu: "sidebar" shows the name full-width in the
// desktop footer; "compact" is an icon-only trigger for the mobile top bar.
export function UserMenuButton({
  variant = "sidebar",
}: {
  variant?: "sidebar" | "compact";
}) {
  const { data: session, isPending } = useSession();
  const router = useRouter();
  if (isPending || !session) return null;

  const email = session.user.email;
  const name = session.user.name || email || "Account";

  const signOut = () =>
    authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.push("/");
          router.refresh();
        },
      },
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account menu"
        className={cn(
          "flex items-center outline-none transition-colors",
          variant === "sidebar"
            ? "w-full gap-2.5 text-sm text-foreground hover:text-foreground focus-visible:text-foreground"
            : "text-subtle hover:text-foreground focus-visible:text-foreground",
        )}
      >
        {variant === "sidebar" ? (
          <>
            <User
              aria-hidden
              className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
              strokeWidth={1.5}
            />
            <span className="min-w-0 flex-1 truncate text-left">{name}</span>
            <ChevronsUpDown
              aria-hidden
              className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
              strokeWidth={1.5}
            />
          </>
        ) : (
          <User aria-hidden className="h-4 w-4" strokeWidth={1.5} />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={variant === "sidebar" ? "top" : "bottom"}
        align={variant === "sidebar" ? "start" : "end"}
        className="min-w-[200px]"
      >
        <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
          <span className="truncate font-medium text-foreground">{name}</span>
          {email && email !== name && (
            <span className="truncate text-xs font-normal text-subtle">
              {email}
            </span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings/account" className="gap-2">
            <Settings
              aria-hidden
              className="h-3.5 w-3.5 text-subtle"
              strokeWidth={1.5}
            />
            Account
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive className="gap-2" onSelect={signOut}>
          <LogOut aria-hidden className="h-3.5 w-3.5" strokeWidth={1.5} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
