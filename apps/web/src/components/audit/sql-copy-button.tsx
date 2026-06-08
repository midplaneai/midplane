"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

// Inline copy affordance for the audit list SQL cell. The whole row is one
// stretched link to the detail page (see audit/page.tsx), so this button
// must sit ABOVE the link overlay (`relative z-10`) and swallow the click
// (preventDefault + stopPropagation) — otherwise copying would also
// navigate. Hidden until row hover / keyboard focus to keep the table calm.
export function SqlCopyButton({
  sql,
  className,
}: {
  sql: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      aria-label={copied ? "Copied SQL" : "Copy SQL"}
      title={copied ? "Copied" : "Copy SQL"}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(sql);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard API unavailable (insecure context / denied) — no-op.
        }
      }}
      className={cn(
        "relative z-10 shrink-0 rounded-[3px] border border-transparent p-1 text-subtle opacity-0 transition-opacity",
        "hover:border-border hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[hsl(var(--ring))]",
        "group-hover/row:opacity-100",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3 w-3 text-[hsl(var(--allow))]" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  );
}
