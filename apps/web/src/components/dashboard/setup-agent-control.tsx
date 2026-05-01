"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";

import { AgentSetupSheet } from "@/components/agent-setup-sheet";
import { Button } from "@/components/ui/button";

// Renders the [Setup agent →] button alongside the controlled sheet.
// `autoOpen` flips the sheet open immediately — used for the post-creation
// redirect (`?setup=<id>` on /dashboard). Initial state is seeded from the
// prop so SSR + CSR paint match without a flicker; on close we strip the
// query param so a reload doesn't re-trigger.

export function SetupAgentControl({
  connectionName,
  mcpUrl,
  mcpToken,
  autoOpen = false,
}: {
  connectionName: string | null;
  mcpUrl: string;
  mcpToken: string;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && autoOpen && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.has("setup")) {
        url.searchParams.delete("setup");
        window.history.replaceState(null, "", url.toString());
      }
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        Setup agent
        <ArrowRight className="ml-1.5 h-3.5 w-3.5" strokeWidth={1.5} />
      </Button>
      <AgentSetupSheet
        open={open}
        onOpenChange={handleOpenChange}
        mcpUrl={mcpUrl}
        mcpToken={mcpToken}
        connectionName={connectionName}
      />
    </>
  );
}
