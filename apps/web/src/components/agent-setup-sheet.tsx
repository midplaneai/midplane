"use client";

import { Check, Loader2, X } from "lucide-react";
import { useState, useTransition } from "react";

import { ClientConfigTabs } from "@/components/client-config-tabs";
import { CopyButton } from "@/components/copy-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

// Agent setup side sheet — wraps ClientConfigTabs (Cursor / Claude Code /
// Claude Desktop copy-paste blocks) and surfaces the MCP URL up top.
//
// Triggered from the dashboard ([Setup agent] button) or auto-opened on
// first connection creation via ?setup=<id> on the post-creation redirect.
//
// The sheet is controlled — the dashboard owns the open state so it can
// react to query-param-driven auto-open.

interface AgentSetupSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mcpUrl: string;
  mcpToken: string;
  connectionName: string | null;
}

type TestState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "ok"; region: string }
  | { status: "error"; message: string };

export function AgentSetupSheet({
  open,
  onOpenChange,
  mcpUrl,
  mcpToken,
  connectionName,
}: AgentSetupSheetProps) {
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [, startTransition] = useTransition();

  function runTest() {
    setTest({ status: "pending" });
    startTransition(async () => {
      // Hit the same /mcp/<token>/health route the agent will reach. The
      // route resolves through the regional Fly app in prod and falls
      // back to Next.js locally — same contract surface.
      try {
        const res = await fetch(`/mcp/${mcpToken}/health`, {
          method: "GET",
          cache: "no-store",
        });
        if (!res.ok) {
          setTest({
            status: "error",
            message: `HTTP ${res.status}`,
          });
          return;
        }
        const json = (await res.json()) as { ok?: boolean; region?: string };
        if (!json.ok) {
          setTest({ status: "error", message: "endpoint not ready" });
          return;
        }
        setTest({ status: "ok", region: json.region ?? "" });
      } catch (err) {
        setTest({
          status: "error",
          message: err instanceof Error ? err.message : "unreachable",
        });
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Set up your agent</SheetTitle>
          <SheetDescription>
            Paste the URL below into Cursor, Claude Code, or Claude Desktop
            and the agent will reach{" "}
            <span className="font-mono text-foreground">
              {connectionName ?? "this connection"}
            </span>{" "}
            through Midplane.
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="agent-setup-mcp-url">MCP endpoint URL</Label>
            <div className="flex items-center gap-2">
              <Input
                id="agent-setup-mcp-url"
                readOnly
                value={mcpUrl}
                className="font-mono"
              />
              <CopyButton value={mcpUrl} />
            </div>
          </div>
          <ClientConfigTabs mcpUrl={mcpUrl} />
        </SheetBody>
        <SheetFooter>
          <TestResult state={test} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={runTest}
            disabled={test.status === "pending"}
          >
            {test.status === "pending" ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Testing…
              </>
            ) : (
              "Test connection"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function TestResult({ state }: { state: TestState }) {
  if (state.status === "idle" || state.status === "pending") {
    return <span className="flex-1" />;
  }
  if (state.status === "ok") {
    return (
      <span className="flex flex-1 items-center gap-1.5 text-xs text-[hsl(var(--allow))]">
        <Check className="h-3.5 w-3.5" strokeWidth={2} />
        Reachable from agent{state.region ? ` · ${state.region}` : ""}
      </span>
    );
  }
  return (
    <span className="flex flex-1 items-center gap-1.5 text-xs text-[hsl(var(--deny))]">
      <X className="h-3.5 w-3.5" strokeWidth={2} />
      Unreachable: {state.message}
    </span>
  );
}
