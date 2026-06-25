"use client";

import { CopyButton } from "@/components/copy-button";
import { Input } from "@/components/ui/input";

// Shared surface for displaying a freshly-minted, show-once MCP token URL with
// a copy affordance. Used by the create-token modal: the plaintext is in React
// state from the create-action response (never round-tripped through a cookie),
// shown once. The modal gates its dismiss/close affordance behind a short
// countdown (useUnlockCountdown) so the URL can't be fat-fingered away before
// it has registered.
export function ShowOnceUrl({ mcpUrl }: { mcpUrl: string }) {
  return (
    <div className="space-y-3">
      <div className="flex items-stretch gap-2">
        <Input
          readOnly
          value={mcpUrl}
          className="font-mono text-xs"
          aria-label="MCP endpoint URL"
          data-testid="show-once-url"
        />
        <CopyButton value={mcpUrl} />
      </div>
      <p className="text-xs text-muted-foreground">
        Paste this into your MCP-compatible agent (Cursor, Claude Code, etc.).
        The URL is a credential — treat it like a password.
      </p>
    </div>
  );
}
