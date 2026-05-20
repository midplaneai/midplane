"use client";

import { useEffect, useRef } from "react";

import { CopyButton } from "@/components/copy-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { consumeShowOnceCookie } from "./consume-action";

// Client island that renders the once-only MCP URL and fires the
// consume Server Action on mount so a subsequent reload sees the
// cookie absent and falls through to the "already shown" state on the
// server. useRef gate ensures the action fires exactly once even under
// React 19 strict-mode double-mount.

export function ShowOnceUrl({ mcpUrl }: { mcpUrl: string }) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    // Fire-and-forget: the action returns void and the page render is
    // already complete. A failed delete just means the next reload may
    // still see the URL (graceful degradation; 5-min cookie TTL caps
    // the leakage window regardless).
    void consumeShowOnceCookie();
  }, []);

  return (
    <div className="space-y-2">
      <Label htmlFor="mcp-url">MCP endpoint URL</Label>
      <div className="flex items-center gap-2">
        <Input id="mcp-url" readOnly value={mcpUrl} className="font-mono" />
        <CopyButton value={mcpUrl} />
      </div>
    </div>
  );
}
