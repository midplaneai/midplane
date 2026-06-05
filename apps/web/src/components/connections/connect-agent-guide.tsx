"use client";

import { useId, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

// The "set up your agent" card: per-client MCP config behind tabs. Shared
// by three surfaces so the connect instructions live in exactly one place:
//   - the connection (Connect) page, as a reference with a placeholder URL
//   - the create-token modal's success panel, with the real show-once URL
//   - the post-create /connections/[id]/created success page
//
// The URL is the one piece that's secret and show-once. When `mcpUrl` is
// present (right after a mint) the snippets carry the real URL and a copy
// affordance. Without it we render a `<token>` placeholder and say plainly
// that the URL only appears at connect time — we never show a masked URL
// behind a Copy button (it would look copyable but paste a dead string).
//
// "use client" + no `@midplane-cloud/db` import keeps this off the Node-only
// driver path (see CLAUDE.md). CopyButton is already a client island.

type Client = "cursor" | "claude";

const TABS: { id: Client; label: string }[] = [
  { id: "cursor", label: "cursor" },
  { id: "claude", label: "claude code" },
];

function slugify(name: string | null | undefined): string {
  const base = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base ? `midplane-${base}` : "midplane";
}

export function ConnectAgentGuide({
  connectionName,
  region,
  mcpUrl,
  className,
}: {
  connectionName?: string | null;
  region?: string | null;
  mcpUrl?: string | null;
  className?: string;
}) {
  const [active, setActive] = useState<Client>("cursor");
  const tablistId = useId();

  const serverKey = slugify(connectionName);
  const hasUrl = Boolean(mcpUrl);
  const url = mcpUrl ?? `https://${region ?? "<region>"}.midplane.ai/mcp/<token>`;

  const cursorJson = `{
  "mcpServers": {
    "${serverKey}": {
      "url": "${url}"
    }
  }
}`;

  const claudeCli = `claude mcp add --transport http ${serverKey} \\
  ${url}`;

  const claudeJson = `{
  "mcpServers": {
    "${serverKey}": {
      "type": "http",
      "url": "${url}"
    }
  }
}`;

  return (
    <div className={cn("border border-border bg-card", className)}>
      <div className="px-4 pt-4">
        <h3 className="text-sm font-medium text-foreground">Set up your agent</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Pick your client and copy the config. The{" "}
          <span className="font-mono">url</span> line is this connection&apos;s
          MCP server.
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Agent client"
        className="mt-3 flex gap-0.5 border-b border-border px-4"
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
          <CodeBlock
            path="~/.cursor/mcp.json"
            code={cursorJson}
            copyable={hasUrl}
          />
        )}
        {active === "claude" && (
          <>
            <CodeBlock
              path="run in your project root"
              code={claudeCli}
              copyable={hasUrl}
            />
            <CodeBlock
              path="or commit .mcp.json"
              code={claudeJson}
              copyable={hasUrl}
            />
          </>
        )}

        {!hasUrl && (
          <p className="text-[11px] text-subtle">
            Your URL is <span className="text-muted-foreground">shown once</span>{" "}
            when you connect an agent — it drops into the{" "}
            <span className="font-mono">{"<token>"}</span> slot above.
          </p>
        )}
      </div>
    </div>
  );
}

function CodeBlock({
  path,
  code,
  copyable,
}: {
  path: string;
  code: string;
  copyable: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
        {path}
      </div>
      <div className="relative">
        <pre className="overflow-x-auto border border-border bg-secondary p-3 pr-16 font-mono text-[12px] leading-relaxed text-muted-foreground">
          {code}
        </pre>
        {copyable && (
          <div className="absolute right-2 top-2">
            <CopyButton value={code} />
          </div>
        )}
      </div>
    </div>
  );
}
