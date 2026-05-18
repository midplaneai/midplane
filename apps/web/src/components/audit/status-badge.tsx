import { Badge } from "@/components/ui/badge";
import type { QueryStatus } from "@/lib/audit";

// One pill per terminal query state. ALLOW·EXEC and ALLOW·FAILED both
// passed the policy decision but diverged at execution; rendering them
// with different semantic colors (allow vs deny) makes the failure path
// scannable in a long list. POLICY_RELOAD uses the brand `accent` color
// because it isn't a query outcome at all — it's an operator event the
// OSS engine emits on a successful hot-swap, surfaced here so admins
// have one place to verify the reload landed.
const VARIANT_MAP: Record<
  QueryStatus,
  "default" | "accent" | "allow" | "deny" | "warn"
> = {
  ALLOWED: "allow",
  DENIED: "deny",
  FAILED: "deny",
  STUCK: "warn",
  PENDING: "default",
  POLICY_RELOAD: "accent",
};

const LABEL_MAP: Record<QueryStatus, string> = {
  ALLOWED: "ALLOW · EXEC",
  DENIED: "DENY",
  FAILED: "ALLOW · FAILED",
  STUCK: "STUCK",
  PENDING: "PENDING",
  POLICY_RELOAD: "POLICY · RELOAD",
};

const ARIA_MAP: Record<QueryStatus, string> = {
  ALLOWED: "Allowed and executed",
  DENIED: "Denied by policy",
  FAILED: "Allowed but failed during execution",
  STUCK: "Stuck — no terminal stage observed",
  PENDING: "In flight",
  POLICY_RELOAD: "Policy hot-swap reload",
};

export function StatusBadge({ status }: { status: QueryStatus }) {
  return (
    <Badge variant={VARIANT_MAP[status]} aria-label={ARIA_MAP[status]}>
      {LABEL_MAP[status]}
    </Badge>
  );
}

export function statusLabel(status: QueryStatus): string {
  return LABEL_MAP[status];
}

// One-line description for a POLICY_RELOADED row that captures both which
// sections of the policy changed and which DBs received the change. OSS
// 0.4.0 emits `sections_changed` and `databases_changed` alongside the
// per-DB diff; older rows (pre-0.4.0) won't have those fields, so we fall
// back to the previous generic label rather than rendering an empty hint.
export function policyReloadSummary(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return ARIA_MAP.POLICY_RELOAD;
  }
  const p = payload as Record<string, unknown>;
  const sections = stringArray(p.sections_changed);
  const databases = stringArray(p.databases_changed);
  if (sections.length === 0 || databases.length === 0) {
    return ARIA_MAP.POLICY_RELOAD;
  }
  const sectionList = sections
    .map((s) => (s === "tenant_scope" ? "tenant_scope" : "table_access"))
    .join(" + ");
  return `${sectionList} updated on ${databases.join(", ")}`;
}

function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}
