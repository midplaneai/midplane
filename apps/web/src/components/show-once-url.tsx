"use client";

import { useEffect, useRef } from "react";

import { CopyButton } from "@/components/copy-button";
import { Input } from "@/components/ui/input";

// Shared surface for displaying a freshly-minted MCP URL with a copy
// affordance. Used by:
//   - /connections/[id]/created — the post-create success page, where the
//     plaintext arrives via an httpOnly cookie (crosses the create →
//     success redirect boundary). It passes `onMount` to fire the
//     Server Action that deletes the cookie so a reload falls through to
//     the "already shown" state.
//   - The create-token modal (PR3) — the plaintext is in React state from
//     the create-API response; no cookie dance needed, so `onMount` is
//     omitted.
//
// useRef gate ensures `onMount` fires exactly once even under React 19
// strict-mode double-mount. The fire-and-forget posture is intentional:
// a failed cookie delete just means the next reload may still see the
// URL (graceful degradation; the 5-minute cookie TTL caps the leakage
// window regardless).

export function ShowOnceUrl({
  mcpUrl,
  onMount,
}: {
  mcpUrl: string;
  onMount?: () => void | Promise<void>;
}) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    if (onMount) void onMount();
  }, [onMount]);

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
        Paste this into your MCP-compatible agent (Cursor, Claude Code,
        Continue, etc.). The URL is a credential — treat it like a password.
      </p>
    </div>
  );
}
