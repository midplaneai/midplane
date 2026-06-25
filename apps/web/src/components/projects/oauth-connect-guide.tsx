"use client";

import { useId, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { DOCS_CONNECT_AGENT_URL } from "@/lib/docs";
import { cn } from "@/lib/utils";

// The canonical "connect an agent" card (OAuth). One component, one place the
// connect instructions live — shown on the project Connect pane.
//
// Shows this project's MCP endpoint URL — /mcp/<projectId> — plus the per-client
// config to paste. The path pins the project so the credential binds HERE at
// consent (the region-wide /mcp would derive the project from the grant set,
// which can bind a multi-project user to the wrong project). The URL is NOT a
// secret: the agent authenticates with an OAuth sign-in, and at consent the user
// grants it access to this project's databases. So it's persistent and copyable,
// no show-once. Works with any MCP client (Cursor, Claude Code, Claude Desktop,
// ChatGPT, …).
//
// For headless agents (CI, workflows) that can't do a browser sign-in, the
// machine-token list sits below this card — those carry a stored bearer secret.
//
// "use client" + no `@midplane-cloud/db` import keeps this off the Node-only
// driver path (see CLAUDE.md). CopyButton is already a client island.

type Client = "cursor" | "claude" | "desktop";

const TABS: { id: Client; label: string }[] = [
  { id: "cursor", label: "cursor" },
  { id: "claude", label: "claude code" },
  { id: "desktop", label: "claude desktop / chatgpt" },
];

function slugify(name: string | null | undefined): string {
  const base = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base ? `midplane-${base}` : "midplane";
}

export function OAuthConnectGuide({
  projectName,
  mcpUrl,
  className,
}: {
  projectName?: string | null;
  mcpUrl: string;
  className?: string;
}) {
  const [active, setActive] = useState<Client>("cursor");
  const tablistId = useId();

  const serverKey = slugify(projectName);

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
          Connect an agent
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Paste this URL into any MCP client and sign in. The URL is an address,
          not a secret — at sign-in you grant the agent access to this
          project&apos;s databases. Works with Cursor, Claude Code, Claude
          Desktop, ChatGPT, and any other MCP client.
        </p>
      </div>

      {/* The endpoint URL itself — always visible + copyable (not a secret). */}
      <div className="mt-3 px-4">
        <div className="mb-1.5 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
          mcp server url
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
              In Claude Desktop or ChatGPT: Settings → Connectors →{" "}
              <span className="font-medium">Add custom connector</span>, then
              paste the URL above.
            </p>
          </div>
        )}

        <p className="text-[11px] text-subtle">
          No token to copy — your client registers itself and you sign in once.
          Revoke access any time from the agent list below, or by pausing the
          project.{" "}
          <a
            href={DOCS_CONNECT_AGENT_URL}
            target="_blank"
            rel="noreferrer"
            className="text-[hsl(var(--brand))] underline underline-offset-2"
          >
            Read the docs →
          </a>
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
