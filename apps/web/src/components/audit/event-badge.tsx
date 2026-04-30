import { Badge } from "@/components/ui/badge";

const VARIANT_MAP: Record<
  string,
  "default" | "accent" | "allow" | "deny" | "warn"
> = {
  ATTEMPTED: "default",
  DECIDED: "accent",
  EXECUTED: "allow",
  FAILED: "deny",
};

const ARIA_MAP: Record<string, string> = {
  ATTEMPTED: "Attempted",
  DECIDED: "Decision recorded",
  EXECUTED: "Executed successfully",
  FAILED: "Execution failed",
};

export function EventBadge({ eventType }: { eventType: string }) {
  const variant = VARIANT_MAP[eventType] ?? "default";
  const aria = ARIA_MAP[eventType] ?? eventType;
  return (
    <Badge variant={variant} aria-label={aria}>
      {eventType}
    </Badge>
  );
}
