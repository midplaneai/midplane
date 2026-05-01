import { type AccessLevel } from "@midplane-cloud/db/policy";

import { cn } from "@/lib/utils";

// Default-agent-access radio used by both the create-connection form and
// the add-database inline form. The wrapper card uses :has(:checked) so
// the visual selection follows the native radio without a controlled
// state — works the same in either form's submit-via-formData posture.

export function AccessRadio({
  value,
  label,
  description,
  defaultChecked,
  name = "default_access",
}: {
  value: AccessLevel;
  label: string;
  description: string;
  defaultChecked?: boolean;
  name?: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 transition-colors",
        "hover:border-border-strong has-[:checked]:border-[hsl(var(--brand))] has-[:checked]:ring-1 has-[:checked]:ring-[hsl(var(--brand)/0.4)]",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="mt-1 accent-[hsl(var(--brand))]"
      />
      <div className="space-y-0.5">
        <div className="text-sm font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </label>
  );
}
