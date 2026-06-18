// Shared section descriptors for the project workspace. Kept in a pure
// (non-"use client") module so the server page can import the VALUE: a
// constant exported from a "use client" module crosses the boundary as a
// client-reference proxy (undefined at runtime), which is why importing
// PROJECT_SECTIONS straight from project-rail.tsx blew up.
//
// Two levels, three tabs: a project has database(s) and the endpoint
// around them. "Database" holds everything per-DB (policy, scoping, test,
// credential) with a switch/add strip on top; "Agents" and "Settings" are
// project-wide. The per-DB aspects are intentionally NOT separate tabs —
// they all share one database context, so splitting them just duplicated it.

export type ProjectSection = "database" | "agents" | "settings";

export const PROJECT_SECTIONS: {
  value: ProjectSection;
  label: string;
}[] = [
  { value: "database", label: "Database" },
  { value: "agents", label: "Agents" },
  { value: "settings", label: "Settings" },
];
