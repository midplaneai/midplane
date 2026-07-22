"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";
import { createSampleProject } from "@/lib/sample-project";

// Importing the server action into a client component gives us useFormStatus'
// pending state (and double-submit protection) while keeping the sample DSN on
// the server — the "use server" boundary means the browser gets an RPC stub,
// not the action's implementation or its db imports.
function Submit({
  label,
  variant,
  size,
}: {
  label: string;
  variant: "default" | "outline";
  size: "sm" | "lg";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} disabled={pending}>
      {pending ? "Setting up…" : label}
    </Button>
  );
}

/**
 * One-click "Try the sample database" CTA. Render only when the hosted sample
 * DSN is configured — callers gate on `process.env.MIDPLANE_SAMPLE_DSN`. Posts
 * to createSampleProject, which provisions the project server-side and
 * redirects to the Connect pane; the connection string never reaches the
 * client (unlike the paste-DSN form).
 */
export function SampleProjectButton({
  entry,
  variant = "outline",
  size = "sm",
  label = "Try the sample database",
}: {
  /** Which surface the CTA sits on, recorded on the funnel events. */
  entry: "dashboard_empty" | "project_empty" | "new_form";
  variant?: "default" | "outline";
  size?: "sm" | "lg";
  label?: string;
}) {
  return (
    <form action={createSampleProject}>
      <input type="hidden" name="entry" value={entry} />
      <Submit label={label} variant={variant} size={size} />
    </form>
  );
}
