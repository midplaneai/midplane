"use client";

import { Download } from "lucide-react";
import { useId, useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { buttonVariants } from "@/components/ui/button";
import { DOCS_CONNECT_AGENT_URL } from "@/lib/docs";
import { cn } from "@/lib/utils";

// The canonical "connect an agent" card (OAuth). One component, one place the
// connect instructions live — shown on the project Connect pane.
//
// Shows the region-wide MCP endpoint URL — /mcp — plus the per-client config to
// paste. One URL per account; at sign-in the user chooses which project +
// databases the agent gets (the consent screen forces an explicit project
// choice for multi-project users, so it can't silently bind to the wrong one).
// We name this project in the copy so the user knows which to pick. The URL is
// NOT a secret: the agent authenticates with an OAuth sign-in, so it's
// persistent and copyable, no show-once. Works with any MCP client (Cursor,
// Claude Code, VS Code, Claude Desktop, ChatGPT, …).
//
// Copy principle (see docs/agents/overview): carry only DURABLE, Midplane-owned
// facts (endpoint URL, Streamable HTTP transport, OAuth sign-in). Let each
// client own its volatile mechanics (CLI flags, config paths, UI navigation).
// Two calibrated exceptions: the `--transport http` gotcha in Claude Code
// (fails silently without it), and short menu paths for the UI-only clients
// (Claude Desktop, ChatGPT) — those have no config to paste, so without a
// pointer the tab would be empty. Each UI-only tab links the client's OFFICIAL
// setup doc as the source of truth when menus move, and the card header links
// our own step-by-step guide (DOCS_CONNECT_AGENT_URL).
//
// For headless agents (CI, workflows) that can't do a browser sign-in, the
// machine-token list sits below this card — those carry a stored bearer secret.
//
// "use client" + no `@midplane-cloud/db` import keeps this off the Node-only
// driver path (see CLAUDE.md). CopyButton is already a client island.

type Client =
  | "cursor"
  | "claude"
  | "vscode"
  | "claudedesktop"
  | "chatgpt"
  | "prompt";

// Conventional per-client paths lead; the agent-driven prompt is the fallback,
// so it sits last and is relabeled to describe what it does, not what it is.
const TABS: { id: Client; label: string }[] = [
  { id: "cursor", label: "cursor" },
  { id: "claude", label: "claude code" },
  { id: "vscode", label: "vs code" },
  { id: "claudedesktop", label: "claude desktop" },
  { id: "chatgpt", label: "chatgpt" },
  { id: "prompt", label: "let your agent do it" },
];

// Official per-client setup docs — the durable source of truth when the
// clients' own menus move. Ours goes in the card header.
const CLAUDE_CONNECTOR_DOC_URL =
  "https://support.claude.com/en/articles/11176164-use-connectors-to-extend-claude-s-capabilities";
const CHATGPT_DEV_MODE_DOC_URL =
  "https://developers.openai.com/api/docs/guides/developer-mode";

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
  // Named in the copy so the user picks the right project at the consent screen
  // (the URL is account-wide, not project-specific).
  const projectLabel = projectName?.trim() || "this project";

  // A localhost/self-host endpoint can't be encoded in a one-click install
  // deeplink (and the hosted Connectors UI rejects http://localhost), so we
  // fall back to manual config when the endpoint is self-hosted.
  const isSelfHost = mcpUrl.startsWith("http://");

  // Self-host ChatGPT: the tunneled hostname must forward to the SAME endpoint
  // path, so the example in that tab carries the real path from mcpUrl.
  let mcpPath = "/mcp";
  try {
    mcpPath = new URL(mcpUrl).pathname;
  } catch {
    // keep the fallback
  }

  const cursorDeeplink =
    `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(serverKey)}` +
    `&config=${btoa(JSON.stringify({ url: mcpUrl }))}`;
  const vscodeDeeplink = `vscode:mcp/install?${encodeURIComponent(
    JSON.stringify({ name: serverKey, type: "http", url: mcpUrl }),
  )}`;

  // Cursor auto-detects the HTTP transport, so the config carries the url only.
  const cursorJson = `{
  "mcpServers": {
    "${serverKey}": {
      "url": "${mcpUrl}"
    }
  }
}`;

  const vscodeJson = `{
  "servers": {
    "${serverKey}": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`;

  const claudeCli = `claude mcp add --transport http ${serverKey} ${mcpUrl}`;

  // The mcp-remote stdio shim bridges a local HTTP endpoint into Claude
  // Desktop, whose hosted Connectors can't reach http://localhost. (ChatGPT
  // has no local-config equivalent — its tab points at a public tunnel.)
  const desktopShimJson = `{
  "mcpServers": {
    "${serverKey}": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${mcpUrl}"]
    }
  }
}`;

  // Declarative, client-agnostic prompt: durable facts + the one Claude Code
  // gotcha. No per-client enumeration and no Desktop/ChatGPT line — a pasted
  // prompt only helps agentic clients that have a shell.
  const setupPrompt = `Add Midplane as an MCP server in this client, over Streamable HTTP (MCP type: "http"). My endpoint is ${mcpUrl}.

Add it using whatever this client uses to register a remote MCP server — its own CLI, config file, or add-server command. Setup details vary by client and version, so use the client's current method rather than a fixed command. One known gotcha: in Claude Code, \`claude mcp add\` needs the --transport http flag (claude mcp add --transport http ${serverKey} ${mcpUrl}), or it treats the URL as a stdio command and fails silently.

Don't invent or ask me for an auth token — Midplane authorizes over OAuth. After you add the server, trigger a connection and hand back to me to sign in in the browser. Once connected, confirm the Midplane tools (query, list_tables, describe_table) appear.`;

  return (
    <div className={cn("border border-border bg-card", className)}>
      <div className="px-4 pt-4">
        <h3 className="text-sm font-medium text-foreground">
          Connect an agent
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Paste this URL into any MCP client and sign in. At sign-in, choose{" "}
          <span className="font-medium text-foreground">{projectLabel}</span> and
          the databases this agent should reach. Works with Cursor, Claude Code,
          VS Code, Claude Desktop, ChatGPT, and any other MCP client. Full
          walkthroughs for every client:{" "}
          <a
            href={DOCS_CONNECT_AGENT_URL}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            connect-an-agent docs
          </a>
          .
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
        className="mt-4 flex flex-wrap gap-0.5 border-b border-border px-4"
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
                "-mb-px whitespace-nowrap border-b-2 px-3 py-2 font-mono text-[11.5px] lowercase tracking-[0.04em] transition-colors",
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
          <div className="space-y-3">
            {!isSelfHost && (
              <InstallButton href={cursorDeeplink} label="Install in Cursor" />
            )}
            <CodeBlock path="~/.cursor/mcp.json" code={cursorJson} />
          </div>
        )}

        {active === "claude" && (
          <div className="space-y-2">
            <CodeBlock path="run in your project root" code={claudeCli} />
            <p className="text-[11px] text-subtle">
              The{" "}
              <code className="font-mono text-muted-foreground">
                --transport http
              </code>{" "}
              flag is required. Without it, Claude Code reads the URL as a stdio
              command and fails silently.
            </p>
          </div>
        )}

        {active === "vscode" && (
          <div className="space-y-3">
            {!isSelfHost && (
              <InstallButton href={vscodeDeeplink} label="Install in VS Code" />
            )}
            <CodeBlock path=".vscode/mcp.json" code={vscodeJson} />
          </div>
        )}

        {active === "claudedesktop" && (
          <div className="space-y-2">
            {isSelfHost ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Connectors run from Anthropic&apos;s cloud and can&apos;t
                  reach a{" "}
                  <code className="font-mono">http://localhost</code> URL, so
                  bridge it with the{" "}
                  <code className="font-mono">mcp-remote</code> stdio shim. Open
                  the config via{" "}
                  <span className="font-medium">
                    Settings → Developer → Edit Config
                  </span>{" "}
                  and add:
                </p>
                <CodeBlock
                  path="claude_desktop_config.json"
                  code={desktopShimJson}
                />
              </>
            ) : (
              <ol className="list-decimal space-y-1.5 pl-4 text-xs text-muted-foreground">
                <li>
                  In Claude Desktop (or claude.ai): open{" "}
                  <span className="font-medium text-foreground">
                    Settings → Connectors
                  </span>{" "}
                  and choose{" "}
                  <span className="font-medium text-foreground">
                    Add custom connector
                  </span>
                  .
                </li>
                <li>
                  Name it (e.g.{" "}
                  <code className="font-mono">{serverKey}</code>) and paste the
                  URL above — leave the advanced OAuth fields empty.
                </li>
                <li>
                  Click <span className="font-medium text-foreground">Add</span>
                  , then{" "}
                  <span className="font-medium text-foreground">Connect</span>{" "}
                  and sign in. At the consent screen, pick {projectLabel} and
                  the databases this agent may reach.
                </li>
              </ol>
            )}
            <p className="text-[11px] text-subtle">
              Available on every Claude plan (Free allows one custom
              connector). Menus moved?{" "}
              <a
                href={CLAUDE_CONNECTOR_DOC_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-muted-foreground"
              >
                Anthropic&apos;s connector guide
              </a>{" "}
              is the source of truth.
            </p>
          </div>
        )}

        {active === "chatgpt" && (
          <div className="space-y-2">
            {isSelfHost ? (
              <p className="text-xs text-muted-foreground">
                ChatGPT connectors run from OpenAI&apos;s cloud and can&apos;t
                reach a{" "}
                <code className="font-mono">http://localhost</code> URL. Expose
                your self-hosted endpoint on a publicly reachable HTTPS
                hostname (e.g. a tunnel), then follow the steps below with that
                URL.
              </p>
            ) : null}
            <ol className="list-decimal space-y-1.5 pl-4 text-xs text-muted-foreground">
              <li>
                On chatgpt.com: enable{" "}
                <span className="font-medium text-foreground">
                  Developer mode
                </span>{" "}
                under{" "}
                <span className="font-medium text-foreground">
                  Settings → Security and login
                </span>{" "}
                (custom MCP connectors ship behind it).
              </li>
              <li>
                {isSelfHost ? (
                  <>
                    In the apps/connectors settings, add a new connector with
                    your public tunnel URL — keep the same path as the URL
                    above (e.g.{" "}
                    <code className="font-mono">
                      https://midplane.example.com{mcpPath}
                    </code>
                    ), not the unreachable localhost URL itself. Authentication
                    is OAuth, no key to paste.
                  </>
                ) : (
                  <>
                    In the apps/connectors settings, add a new connector with
                    the URL above — authentication is OAuth, no key to paste.
                  </>
                )}
              </li>
              <li>
                Sign in when prompted; at the consent screen, pick{" "}
                {projectLabel} and the databases this agent may reach. Then
                enable the connector from the composer&apos;s tools menu in a
                chat.
              </li>
            </ol>
            <p className="text-[11px] text-subtle">
              Requires Plus, Pro, Business, Enterprise, or Edu on the web.
              Menus moved?{" "}
              <a
                href={CHATGPT_DEV_MODE_DOC_URL}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-muted-foreground"
              >
                OpenAI&apos;s developer-mode guide
              </a>{" "}
              is the source of truth.
            </p>
          </div>
        )}

        {active === "prompt" && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              For agentic CLI/IDE clients with a shell (Claude Code, Cursor,
              Windsurf, Codex): paste this and let the agent register the server
              itself. UI-only clients (Claude Desktop, ChatGPT) can&apos;t run
              it — use the tabs to the left instead.
            </p>
            <CodeBlock path="paste into your agent" code={setupPrompt} wrap />
          </div>
        )}
      </div>
    </div>
  );
}

// A custom-scheme install deeplink, styled as the primary action for its tab.
// Rendered as an <a> (not a Button) so the browser hands the cursor:// or
// vscode: scheme off to the installed client.
function InstallButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className={cn(buttonVariants({ variant: "default", size: "sm" }), "gap-2")}
    >
      <Download aria-hidden className="h-3.5 w-3.5" />
      {label}
    </a>
  );
}

// `wrap` is for prose (the agent setup prompt), which reads better soft-wrapped
// than horizontally scrolled. Code/JSON keep the original scroll-only style.
function CodeBlock({
  path,
  code,
  wrap = false,
}: {
  path: string;
  code: string;
  wrap?: boolean;
}) {
  return (
    <div>
      <div className="mb-1.5 font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
        {path}
      </div>
      <div className="relative">
        <pre
          className={cn(
            "overflow-x-auto border border-border bg-secondary p-3 pr-16 font-mono text-[12px] leading-relaxed text-muted-foreground",
            wrap && "whitespace-pre-wrap break-words",
          )}
        >
          {code}
        </pre>
        <div className="absolute right-2 top-2">
          <CopyButton value={code} />
        </div>
      </div>
    </div>
  );
}
