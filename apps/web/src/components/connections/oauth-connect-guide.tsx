"use client";

import { useId, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

// The interactive-agent connect card (OAuth).
//
// Shows this connection's MCP endpoint URL — /mcp/<connectionId> — plus the
// per-client config to paste. Unlike the old token URL, the connection id is
// NOT a secret: the agent authenticates with an OAuth sign-in, not the URL. So
// the URL is persistent and copyable, no show-once, no "treat as a password".
//
// For headless agents (CI, workflows) that can't do a browser sign-in, the
// API-token list sits below this card — those carry a stored bearer secret.
//
// "use client" + no `@midplane-cloud/db` import keeps this off the Node-only
// driver path (see CLAUDE.md). CopyButton is already a client island.

type Client = "cursor" | "claude" | "desktop";

const TABS: { id: Client; label: string }[] = [
  { id: "cursor", label: "cursor" },
  { id: "claude", label: "claude code" },
  { id: "desktop", label: "claude desktop" },
];

function slugify(name: string | null | undefined): string {
  const base = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base ? `midplane-${base}` : "midplane";
}

export function OAuthConnectGuide({
  connectionName,
  mcpUrl,
  className,
}: {
  connectionName?: string | null;
  mcpUrl: string;
  className?: string;
}) {
  const [active, setActive] = useState<Client>("cursor");
  const tablistId = useId();

  const serverKey = slugify(connectionName);

  const cursorJson = `{
  "mcpServers": {
    "${serverKey}": {
      "url": "${mcpUrl}"
    }
  }
}`;

  const claudeCli = `claude mcp add --transport http ${serverKey} ${mcpUrl}`;

  return (
    <div className={cn("border border-border bg-card", className)}>
      <div className="px-4 pt-4">
        <h3 className="text-sm font-medium text-foreground">
          Connect an interactive agent
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Paste this connection&apos;s endpoint into your client. On first
          connect a browser opens — sign in to Midplane and approve. The URL is
          an address, not a secret; the sign-in is what grants access.
        </p>
      </div>

      {/* The endpoint URL itself — always visible + copyable (not a secret). */}
      <div className="mt-3 px-4">
        <div className="mb-1.5 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
          mcp endpoint
        </div>
        <div className="flex items-center gap-2">
          <code className="flex-1 overflow-x-auto border border-border bg-secondary px-3 py-2 font-mono text-[12px] text-muted-foreground">
            {mcpUrl}
          </code>
          <CopyButton value={mcpUrl} />
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Agent client"
        className="mt-4 flex gap-0.5 border-b border-border px-4"
      >
        {TABS.map((t) => {
          const selected = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${tablistId}-${t.id}`}
              aria-selected={selected}
              onClick={() => setActive(t.id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 font-mono text-[11.5px] lowercase tracking-[0.04em] transition-colors",
                selected
                  ? "border-[hsl(var(--brand))] text-foreground"
                  : "border-transparent text-subtle hover:text-muted-foreground",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-3 p-4">
        {active === "cursor" && (
          <CodeBlock path="~/.cursor/mcp.json" code={cursorJson} />
        )}
        {active === "claude" && (
          <CodeBlock path="run in your project root" code={claudeCli} />
        )}
        {active === "desktop" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Settings → Connectors → <span className="font-medium">Add custom connector</span>,
              then paste the endpoint URL above.
            </p>
          </div>
        )}

        <p className="text-[11px] text-subtle">
          No token to copy — your client registers itself and you sign in once.
          Revoke access any time by pausing or deleting the connection.
        </p>
      </div>
    </div>
  );
}

function CodeBlock({ path, code }: { path: string; code: string }) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
        {path}
      </div>
      <div className="relative">
        <pre className="overflow-x-auto border border-border bg-secondary p-3 pr-16 font-mono text-[12px] leading-relaxed text-muted-foreground">
          {code}
        </pre>
        <div className="absolute right-2 top-2">
          <CopyButton value={code} />
        </div>
      </div>
    </div>
  );
}
