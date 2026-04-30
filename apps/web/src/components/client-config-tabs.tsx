"use client";

import { CopyButton } from "@/components/copy-button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

export function ClientConfigTabs({ mcpUrl }: { mcpUrl: string }) {
  const cursorConfig = JSON.stringify(
    { mcpServers: { midplane: { url: mcpUrl } } },
    null,
    2,
  );

  const claudeCodeCmd = `claude mcp add --transport http midplane ${mcpUrl}`;

  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        midplane: {
          command: "npx",
          args: ["-y", "mcp-remote", mcpUrl],
        },
      },
    },
    null,
    2,
  );

  return (
    <Tabs defaultValue="cursor">
      <TabsList>
        <TabsTrigger value="cursor">Cursor</TabsTrigger>
        <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
        <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
      </TabsList>
      <TabsContent value="cursor">
        <ConfigBlock
          path="~/.cursor/mcp.json"
          value={cursorConfig}
          language="json"
        />
      </TabsContent>
      <TabsContent value="claude-code">
        <ConfigBlock
          path="Run in your terminal"
          value={claudeCodeCmd}
          language="shell"
        />
      </TabsContent>
      <TabsContent value="claude-desktop">
        <ConfigBlock
          path="~/Library/Application Support/Claude/claude_desktop_config.json"
          value={claudeDesktopConfig}
          language="json"
        />
      </TabsContent>
    </Tabs>
  );
}

function ConfigBlock({
  path,
  value,
  language,
}: {
  path: string;
  value: string;
  language: "json" | "shell";
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] uppercase tracking-[0.04em] text-subtle">
        {path}
      </p>
      <div className="relative rounded-md border border-border bg-muted">
        <pre
          className={
            language === "shell"
              ? "overflow-x-auto whitespace-pre-wrap break-all p-4 font-mono text-xs text-foreground"
              : "overflow-x-auto p-4 font-mono text-xs text-foreground"
          }
        >
          {value}
        </pre>
        <div className="absolute right-2 top-2">
          <CopyButton value={value} label="Copy" />
        </div>
      </div>
    </div>
  );
}
