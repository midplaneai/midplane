// Cookie name shared between the create-connection Server Action
// (which writes the plaintext MCP URL) and the consume Server Action
// (which deletes it on the success page).
//
// Lives in its own file because "use server" modules can only export
// async functions — the bare const has to live outside that boundary.
//
// PR2 of mcp_url_auth_security: this cookie is the only delivery
// channel for the default token's plaintext after createConnection
// mints + hashes it. 5-minute TTL bounds the leakage window if the
// user walks away from the browser between create and read; the
// consume Server Action deletes the cookie on the success page's
// first paint so a reload removes the URL from view.

export const SHOW_ONCE_COOKIE = "midplane.show_once_url";
