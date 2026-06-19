"use client";

import { MoreHorizontal } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Compact legal/company menu behind a [⋯] trigger so the Imprint, Privacy, and
// Terms stay reachable inside the app without spending a full footer row.
// Mirrors the dashboard's per-project [⋯] menu. Used in the desktop sidebar
// (bottom, next to the account) and the mobile top bar. The pages themselves
// live on the marketing site (midplane.ai), so these are external links.
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
          <a href="https://midplane.ai/imprint">Imprint</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="https://midplane.ai/privacy">Privacy</a>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="https://midplane.ai/terms">Terms</a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
