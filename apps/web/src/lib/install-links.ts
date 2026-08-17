// One-click MCP install deeplinks (Cursor, VS Code).
//
// Split out of the connect card so the ENCODING is unit-testable. Both links are
// custom-scheme URLs that smuggle a config blob through a query string, and the
// failure mode when the encoding is wrong is silent from our side: the client
// pops its own "invalid configuration" toast and the user reads it as "Midplane's
// button is broken". The tests here assert the round-trip through the same
// parser each client uses.
//
// Pure TS, no runtime deps — safe to import from a "use client" component.

/** The `<name>` of the installed MCP server entry: a stable, client-safe slug
 *  derived from the project name. A name that slugifies to nothing (symbols
 *  only, or absent) falls back to the bare product name. */
export function mcpServerKey(projectName: string | null | undefined): string {
  const base = (projectName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base ? `midplane-${base}` : "midplane";
}

/** Cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=…&config=<base64>`
 *
 *  `config` is the mcp.json SERVER object — the value that lands at
 *  `mcpServers[name]`, not the wrapper — base64-encoded. Cursor detects the
 *  Streamable HTTP transport from a bare `url`, so no `type` field; this is the
 *  same shape Cursor's own in-app "Add" button writes.
 *
 *  The base64 is percent-encoded on top of that. Cursor reads the parameter with
 *  `new URLSearchParams(query).get("config")`, which decodes `+` as a space, and
 *  the standard base64 alphabet includes `+`. One space inside the blob makes it
 *  undecodable ("Invalid server configuration provided: Not valid JSON."). Our
 *  hosted URLs don't currently produce a `+` — it needs a `>` or `~` in the
 *  payload — but that's a property of today's hostnames, not of the contract, so
 *  encode the value rather than depend on the alphabet. */
export function cursorInstallLink(serverKey: string, mcpUrl: string): string {
  const config = btoa(JSON.stringify({ url: mcpUrl }));
  return (
    `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(serverKey)}` +
    `&config=${encodeURIComponent(config)}`
  );
}

/** VS Code: `vscode:mcp/install?<percent-encoded server JSON>`. The whole object
 *  (name + transport + url) rides in the query string itself — no parameter key,
 *  and VS Code wants the transport named explicitly. */
export function vscodeInstallLink(serverKey: string, mcpUrl: string): string {
  return `vscode:mcp/install?${encodeURIComponent(
    JSON.stringify({ name: serverKey, type: "http", url: mcpUrl }),
  )}`;
}
