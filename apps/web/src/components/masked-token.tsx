"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Show a long opaque secret (mcp_token) masked until the user explicitly
// reveals it. The token isn't a *secret* in the credentials sense — anyone
// who got it could reach the MCP endpoint, but the URL contains it too —
// still, defaulting to masked keeps casual over-the-shoulder reads from
// leaking the URL.

export function MaskedToken({ value }: { value: string }) {
  const [revealed, setRevealed] = useState(false);
  const masked = "•".repeat(value.length);

  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        value={revealed ? value : masked}
        className="font-mono"
        aria-label="MCP token"
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setRevealed((r) => !r)}
        aria-label={revealed ? "Hide token" : "Reveal token"}
      >
        {revealed ? (
          <EyeOff className="h-3.5 w-3.5" strokeWidth={1.5} />
        ) : (
          <Eye className="h-3.5 w-3.5" strokeWidth={1.5} />
        )}
      </Button>
      <CopyButton value={value} />
    </div>
  );
}
