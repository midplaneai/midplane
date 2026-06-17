"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import {
  MAX_WORKSPACE_NAME_LENGTH,
  validateWorkspaceName,
} from "@/lib/workspace-name";

// Thin UI over the Better Auth organization plugin's `organization.update`.
// The plugin owns the mutation + permission check (only owner/admin); we own
// the form. (Better Auth is headless — there's no hosted org-settings UI.)
export function RenameWorkspaceForm({
  orgId,
  currentName,
}: {
  orgId: string;
  currentName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);

  const dirty = name.trim() !== currentName.trim();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    const invalid = validateWorkspaceName(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    setPending(true);
    const { error: updateError } = await authClient.organization.update({
      organizationId: orgId,
      data: { name: name.trim() },
    });
    setPending(false);
    if (updateError) {
      setError(updateError.message ?? "Couldn't rename the workspace. Try again.");
      return;
    }
    setSaved(true);
    // Refresh the server-rendered name here; the sidebar label picks up the new
    // name on its next navigation (it reads the active-org store).
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="workspaceName">Workspace name</Label>
        <Input
          id="workspaceName"
          name="workspaceName"
          value={name}
          maxLength={MAX_WORKSPACE_NAME_LENGTH}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-[hsl(var(--deny))]">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className="text-sm text-[hsl(var(--allow))]">Saved.</p>
      )}

      <Button type="submit" size="sm" disabled={pending || !dirty}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
