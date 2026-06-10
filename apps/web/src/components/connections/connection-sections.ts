// Shared section descriptors for the connection workspace. Kept in a pure
// (non-"use client") module so the server page can import the VALUE: a
// constant exported from a "use client" module crosses the boundary as a
// client-reference proxy (undefined at runtime), which is why importing
// CONNECTION_SECTIONS straight from connection-rail.tsx blew up.
//
// Two levels, three tabs: a connection has database(s) and the endpoint
// around them. "Database" holds everything per-DB (policy, scoping, test,
// credential) with a switch/add strip on top; "Agents" and "Settings" are
// connection-wide. The per-DB aspects are intentionally NOT separate tabs —
// they all share one database context, so splitting them just duplicated it.

export type ConnectionSection = "database" | "agents" | "settings";

export const CONNECTION_SECTIONS: {
  value: ConnectionSection;
  label: string;
}[] = [
  { value: "database", label: "Database" },
  { value: "agents", label: "Agents" },
  { value: "settings", label: "Settings" },
];
