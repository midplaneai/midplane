"use client";

import { MoreHorizontal } from "lucide-react";
import Link from "next/link";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Compact legal/company menu behind a [⋯] trigger so the Imprint, Privacy, and
// Terms stay reachable inside the app without spending a full footer row.
// Mirrors the dashboard's per-connection [⋯] menu. Used in the desktop sidebar
// (bottom, next to the account) and the mobile top bar.
export function LegalMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Legal and company information"
        className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-subtle outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
      >
        <MoreHorizontal aria-hidden className="h-4 w-4" strokeWidth={1.5} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuItem asChild>
          <Link href="/imprint">Imprint</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/privacy">Privacy</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/terms">Terms</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
