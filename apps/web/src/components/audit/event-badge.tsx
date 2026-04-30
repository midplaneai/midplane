// 4 OSS event types (engine emits ATTEMPTED → DECIDED → EXECUTED|FAILED).
// Color mapping mirrors the design tokens: ATTEMPTED muted, DECIDED accent
// blue, EXECUTED allow green, FAILED deny red. Mockup mapped on
// allow/deny — we pivot to event_type since that's what the schema actually
// carries; the dashboard demo flows around lifecycle, not pre-/post-decision.

const CLASS_MAP: Record<string, string> = {
  ATTEMPTED: "attempted",
  DECIDED: "decided",
  EXECUTED: "executed",
  FAILED: "failed",
};

const ARIA_MAP: Record<string, string> = {
  ATTEMPTED: "Attempted",
  DECIDED: "Decision recorded",
  EXECUTED: "Executed successfully",
  FAILED: "Execution failed",
};

export function EventBadge({ eventType }: { eventType: string }) {
  const cls = CLASS_MAP[eventType] ?? "attempted";
  const aria = ARIA_MAP[eventType] ?? eventType;
  return (
    <span className={`md-badge ${cls}`} aria-label={aria}>
      <span className="md-badge-dot" aria-hidden />
      {eventType}
    </span>
  );
}
