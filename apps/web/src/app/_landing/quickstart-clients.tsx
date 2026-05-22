"use client";

// Tabbed Quickstart client setup. The page used to render three stacked
// client configs (Cursor, Claude Code, Claude Desktop) — a developer only
// uses one, so on mobile the other two were dead scroll. Tabs let them
// jump straight to theirs while keeping all three visible at the
// tab-list level.
//
// Built on shadcn Tabs (Radix primitive). Tailwind class overrides retheme
// the dark-dashboard defaults for the editorial paper palette — the
// editorial tokens live on .editorial-page only, so we point at them
// explicitly with var() arbitrary values.

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

const tabsListClass = "border-b-[var(--line)] gap-0";
const triggerClass = [
  "px-4 py-3 text-[13px] font-medium",
  "text-[var(--ink-3)]",
  "hover:text-[var(--ink-2)]",
  "data-[state=active]:text-[var(--ink)]",
  "data-[state=active]:after:bg-[var(--ink)]",
  "data-[state=active]:after:h-[2px]",
].join(" ");

export function QuickstartClients() {
  return (
    <Tabs defaultValue="cursor" className="clients-tabs">
      <TabsList className={tabsListClass}>
        <TabsTrigger value="cursor" className={triggerClass}>
          Cursor <span className="ml-2 text-[var(--ink-4)] text-[11px]">verified</span>
        </TabsTrigger>
        <TabsTrigger value="claude-code" className={triggerClass}>
          Claude Code <span className="ml-2 text-[var(--ink-4)] text-[11px]">verified</span>
        </TabsTrigger>
        <TabsTrigger value="claude-desktop" className={triggerClass}>
          Claude Desktop <span className="ml-2 text-[var(--ink-4)] text-[11px]">verified</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="cursor" className="pt-6">
        <pre className="quickstart-block">
          <span className="com"># ~/.cursor/mcp.json</span>
          {"\n{\n  "}
          <b>&quot;mcpServers&quot;</b>
          {": {\n    "}
          <b>&quot;midplane&quot;</b>
          {": {\n      "}
          <b>&quot;url&quot;</b>
          {': "https://eu.midplane.ai/mcp/<tok>"\n    }\n  }\n}'}
        </pre>
      </TabsContent>

      <TabsContent value="claude-code" className="pt-6">
        <pre className="quickstart-block">
          <span className="com"># one line, terminal</span>
          {"\nclaude mcp add \\\n  --transport http \\\n  midplane \\\n  https://eu.midplane.ai/mcp/<tok>"}
        </pre>
      </TabsContent>

      <TabsContent value="claude-desktop" className="pt-6">
        <pre className="quickstart-block">
          <span className="com"># Settings → Connectors → Add</span>
          {"\nname: midplane\nurl:  https://eu.midplane.ai/mcp/<tok>\n\n"}
          <span className="com"># or claude_desktop_config.json</span>
        </pre>
      </TabsContent>
    </Tabs>
  );
}
