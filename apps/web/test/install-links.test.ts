import { describe, expect, it } from "vitest";

import {
  cursorInstallLink,
  mcpServerKey,
  vscodeInstallLink,
} from "@/lib/install-links";

// The one-click install buttons on the project Connect pane hand a config blob
// to another application through a custom-scheme URL. Nothing on our side sees
// the result: if the encoding is wrong the client shows its own error and the
// user reads it as our button being broken. So the assertions below decode each
// link the way the CLIENT decodes it, not the way we built it.

const MCP_URL = "https://eu.midplane.ai/mcp";

/** Cursor's own parse, from Cursor.app's `cursor-deeplink` extension:
 *  `new URLSearchParams(uri.query).get("config")` → base64 → JSON.parse. The
 *  URLSearchParams step is the load-bearing one — it decodes `+` as a space. */
function decodeCursorLink(link: string): { name: string; server: unknown } {
  const query = link.slice(link.indexOf("?") + 1);
  const params = new URLSearchParams(query);
  const name = params.get("name");
  const config = params.get("config");
  if (!name || !config) throw new Error("missing name or config");
  return {
    name,
    server: JSON.parse(Buffer.from(config, "base64").toString("utf8")),
  };
}

describe("mcpServerKey", () => {
  it("slugifies the project name under a midplane- prefix", () => {
    expect(mcpServerKey("Sample")).toBe("midplane-sample");
    expect(mcpServerKey("Prod Analytics")).toBe("midplane-prod-analytics");
    expect(mcpServerKey("  Billing/DB  ")).toBe("midplane-billing-db");
  });

  it("falls back to the bare product name when nothing survives", () => {
    expect(mcpServerKey(null)).toBe("midplane");
    expect(mcpServerKey(undefined)).toBe("midplane");
    expect(mcpServerKey("")).toBe("midplane");
    expect(mcpServerKey("—!—")).toBe("midplane");
  });
});

describe("cursorInstallLink", () => {
  it("uses the scheme + path Cursor's deeplink handler dispatches on", () => {
    const link = cursorInstallLink("midplane-sample", MCP_URL);
    expect(link.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?")).toBe(
      true,
    );
  });

  it("round-trips name + server config through Cursor's parser", () => {
    const { name, server } = decodeCursorLink(
      cursorInstallLink("midplane-sample", MCP_URL),
    );
    expect(name).toBe("midplane-sample");
    // Bare `url`, no `type`: Cursor detects Streamable HTTP itself, and this is
    // the shape its own in-app "Add" button writes to mcp.json.
    expect(server).toEqual({ url: MCP_URL });
  });

  it("survives a payload whose base64 contains '+'", () => {
    // URLSearchParams turns a raw `+` into a space, which corrupts the base64 and
    // makes Cursor report "Invalid server configuration provided: Not valid
    // JSON.". A `~` in the URL is enough to put one there — self-host sets the
    // origin from BETTER_AUTH_URL, so the payload is not ours to constrain.
    const tildeUrl = "https://self.example.com/~u~/mcp";
    expect(Buffer.from(JSON.stringify({ url: tildeUrl })).toString("base64")).toContain(
      "+",
    );

    const { server } = decodeCursorLink(cursorInstallLink("midplane", tildeUrl));
    expect(server).toEqual({ url: tildeUrl });
  });

  it("escapes a server name that would otherwise break out of the parameter", () => {
    // Not reachable through mcpServerKey (it strips everything but a-z0-9), but
    // the two are separable functions and a raw `&` would forge a parameter.
    const { name, server } = decodeCursorLink(
      cursorInstallLink("evil&config=bm9wZQ==", MCP_URL),
    );
    expect(name).toBe("evil&config=bm9wZQ==");
    expect(server).toEqual({ url: MCP_URL });
  });
});

describe("vscodeInstallLink", () => {
  it("round-trips the whole server object through VS Code's parser", () => {
    const link = vscodeInstallLink("midplane-sample", MCP_URL);
    expect(link.startsWith("vscode:mcp/install?")).toBe(true);

    // VS Code decodes the query string itself as the JSON payload — no key.
    const payload = JSON.parse(
      decodeURIComponent(link.slice("vscode:mcp/install?".length)),
    );
    expect(payload).toEqual({
      name: "midplane-sample",
      type: "http",
      url: MCP_URL,
    });
  });
});
