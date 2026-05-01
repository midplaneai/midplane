import { Badge } from "@/components/ui/badge";

// Default mapping by event_type. DECIDED gets `accent` only when no
// decision is known — once we have the decision, color flips to allow/
// deny so the lifecycle section reads the same as the list table's
// status pill (red for DENY, green-ish for allowed-and-executed).
const VARIANT_MAP: Record<
  string,
  "default" | "accent" | "allow" | "deny" | "warn"
> = {
  ATTEMPTED: "default",
  DECIDED: "accent",
  EXECUTED: "allow",
  FAILED: "deny",
  POLICY_RELOADED: "accent",
};

const ARIA_MAP: Record<string, string> = {
  ATTEMPTED: "Attempted",
  DECIDED: "Decision recorded",
  EXECUTED: "Executed successfully",
  FAILED: "Execution failed",
  POLICY_RELOADED: "Policy reload recorded",
};

export function EventBadge({
  eventType,
  decision,
}: {
  eventType: string;
  /** OSS-side decision string from the DECIDED payload ("allow" | "deny").
   *  When passed on a DECIDED event, the badge swaps both color AND label
   *  to the decision (DENY / ALLOW) so the lifecycle reads in the same
   *  vocabulary the list table established. Without this, clicking a row
   *  labeled DENY drops the user onto a page where the same event is
   *  called DECIDED — needless cognitive translation.
   *
   *  Forensic operators who want the raw OSS event_type can still see
   *  it on the JSON payload card; the timeline shape is unchanged. */
  decision?: string | null;
}) {
  const decided = eventType === "DECIDED" ? decision?.toLowerCase() : null;
  const variant = (() => {
    if (decided === "deny") return "deny";
    if (decided === "allow") return "allow";
    return VARIANT_MAP[eventType] ?? "default";
  })();
  const label =
    decided === "deny"
      ? "DENY"
      : decided === "allow"
        ? "ALLOW"
        : eventType;
  const aria = (() => {
    if (decided === "deny") return "Denied by policy";
    if (decided === "allow") return "Allowed by policy";
    return ARIA_MAP[eventType] ?? eventType;
  })();
  return (
    <Badge variant={variant} aria-label={aria}>
      {label}
    </Badge>
  );
}
