"use client";

import { useId, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { cn } from "@/lib/utils";

// The "set up your agent" card: per-client MCP config behind tabs. Shared by
// every connect surface so the instructions live in exactly one place:
//   - the project (Connect) page, as a reference
//   - the create-token modal's success panel (machine token primary)
//   - the post-create /projects/[id]/created success page
//
// TWO ways to connect, and the DEFAULT is OAuth:
//   - OAuth (default): point the agent at the region-wide /mcp URL and sign in.
//     The URL carries NO secret and NO project id — it's just an address, safe
//     to display, copy, and keep on the dashboard. The agent's credential is
//     bound to one project at consent.
//   - Machine / CI token: a credentialed /mcp/<token> URL for headless callers
//     (CI, cron) that can't do an interactive sign-in. The token IS the secret,
//     shown once. Tucked under a disclosure, not the default.
//
// `primary` decides which leads: "oauth" everywhere except the create-token
// modal, which mints a machine token on purpose and passes "token".
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
  projectName,
  oauthUrl,
  tokenUrl,
  primary = "oauth",
  className,
}: {
  projectName?: string | null;
  /** The region-wide OAuth endpoint (mcpGenericUrl) — non-secret. Computed
   *  server-side so it honors the deployment's actual MCP host (localhost in
   *  dev, the self-host domain, or any MIDPLANE_PUBLIC_HOST_* override); a
   *  client component can't see process.env, so it must NOT be derived here. */
  oauthUrl: string;
  /** The show-once machine-token URL (/mcp/<token>), when one was just minted.
   *  Absent on reference surfaces — the machine section then explains the URL
   *  appears once at token creation. */
  tokenUrl?: string | null;
  /** Which connection leads. "token" only in the create-token modal. */
  primary?: "oauth" | "token";
  className?: string;
}) {
  const [active, setActive] = useState<Client>("cursor");
  const tablistId = useId();

  const serverKey = slugify(projectName);

  const hasToken = Boolean(tokenUrl);
  // "token" only leads when we actually have one to show.
  const lead: "oauth" | "token" = primary === "token" && hasToken ? "token" : "oauth";

  const oauthSection = (
    <ClientConfig
      active={active}
      onTab={setActive}
      tablistId={tablistId}
      serverKey={serverKey}
      url={oauthUrl}
      copyable
    />
  );

  const machineSection = hasToken ? (
    <div className="space-y-3">
      <p className="text-[11px] text-[hsl(var(--warn))]">
        This URL is the credential, shown once — store it like a password. Lost
        it? Revoke and mint a new one from the project page.
      </p>
      <ClientConfig
        active={active}
        onTab={setActive}
        tablistId={`${tablistId}-machine`}
        serverKey={serverKey}
        url={tokenUrl!}
        copyable
      />
    </div>
  ) : (
    <div className="space-y-3">
      <ClientConfig
        active={active}
        onTab={setActive}
        tablistId={`${tablistId}-machine`}
        serverKey={serverKey}
        url={`${oauthUrl}/<token>`}
        copyable={false}
      />
      <p className="text-[11px] text-subtle">
        The machine URL is{" "}
        <span className="text-muted-foreground">shown once</span> when you create
        a token — it drops into the <span className="font-mono">{"<token>"}</span>{" "}
        slot above.
      </p>
    </div>
  );

  return (
    <div className={cn("border border-border bg-card", className)}>
      <div className="px-4 pt-4">
        <h3 className="text-sm font-medium text-foreground">Set up your agent</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {lead === "oauth" ? (
            <>
              Point your client at the <span className="font-mono">url</span>{" "}
              below and sign in. No secret to copy — your agent is granted access
              to one project at sign-in.
            </>
          ) : (
            <>
              Pick your client and copy the config. The{" "}
              <span className="font-mono">url</span> line is this token&apos;s
              MCP server.
            </>
          )}
        </p>
      </div>

      <div className="space-y-3 p-4">
        {lead === "oauth" ? oauthSection : machineSection}

        <details className="group rounded-md border border-border bg-background">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle hover:text-foreground">
            <span
              className="transition-transform group-open:rotate-90"
              aria-hidden
            >
              ›
            </span>
            {lead === "oauth"
              ? "machine / ci connection (token)"
              : "connect over oauth (no token)"}
          </summary>
          <div className="space-y-3 px-3 pb-3">
            {lead === "oauth" ? (
              machineSection
            ) : (
              <>
                <p className="text-[11px] text-subtle">
                  Prefer no secret? Point at the region-wide URL and sign in
                  instead.
                </p>
                {oauthSection}
              </>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}

// The cursor / claude-code config snippets for one URL, behind the shared tab
// strip. Rendered for both the OAuth URL and the machine-token URL so the two
// connection modes track the same client selection.
function ClientConfig({
  active,
  onTab,
  tablistId,
  serverKey,
  url,
  copyable,
}: {
  active: Client;
  onTab: (c: Client) => void;
  tablistId: string;
  serverKey: string;
  url: string;
  copyable: boolean;
}) {
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
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="Agent client"
        className="flex gap-0.5 border-b border-border"
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
              onClick={() => onTab(t.id)}
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

      {active === "cursor" && (
        <CodeBlock path="~/.cursor/mcp.json" code={cursorJson} copyable={copyable} />
      )}
      {active === "claude" && (
        <>
          <CodeBlock
            path="run in your project root"
            code={claudeCli}
            copyable={copyable}
          />
          <CodeBlock
            path="or commit .mcp.json"
            code={claudeJson}
            copyable={copyable}
          />
        </>
      )}
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
