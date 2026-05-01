import { Badge } from "@/components/ui/badge";
import type { QueryStatus } from "@/lib/audit";

// One pill per terminal query state. ALLOW·EXEC and ALLOW·FAILED both
// passed the policy decision but diverged at execution; rendering them
// with different semantic colors (allow vs deny) makes the failure path
// scannable in a long list.
const VARIANT_MAP: Record<
  QueryStatus,
  "default" | "accent" | "allow" | "deny" | "warn"
> = {
  ALLOWED: "allow",
  DENIED: "deny",
  FAILED: "deny",
  STUCK: "warn",
  PENDING: "default",
};

const LABEL_MAP: Record<QueryStatus, string> = {
  ALLOWED: "ALLOW · EXEC",
  DENIED: "DENY",
  FAILED: "ALLOW · FAILED",
  STUCK: "STUCK",
  PENDING: "PENDING",
};

const ARIA_MAP: Record<QueryStatus, string> = {
  ALLOWED: "Allowed and executed",
  DENIED: "Denied by policy",
  FAILED: "Allowed but failed during execution",
  STUCK: "Stuck — no terminal stage observed",
  PENDING: "In flight",
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
