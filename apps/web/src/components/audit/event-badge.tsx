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
   *  When passed, overrides the default DECIDED color so the badge agrees
   *  with the list table's StatusBadge. Ignored on non-DECIDED events. */
  decision?: string | null;
}) {
  const variant = (() => {
    if (eventType === "DECIDED" && decision) {
      const d = decision.toLowerCase();
      if (d === "deny") return "deny";
      if (d === "allow") return "allow";
    }
    return VARIANT_MAP[eventType] ?? "default";
  })();
  const aria = ARIA_MAP[eventType] ?? eventType;
  return (
    <Badge variant={variant} aria-label={aria}>
      {eventType}
    </Badge>
  );
}
