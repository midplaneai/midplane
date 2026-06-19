// Human labels for TableAccessPolicy levels, shared by the dashboard's
// DatabaseRow and the project home's databases section. One
// vocabulary: "read", "deny", "read · write" — the interpunct form
// matches the audit log's badge copy.

export function accessLabel(level: string): string {
  if (level === "read") return "read";
  if (level === "deny") return "deny";
  if (level === "read_write") return "read · write";
  return level;
}
