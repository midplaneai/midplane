"use client";

import { useState } from "react";

import { RenameDatabaseInline } from "@/components/dashboard/rename-database-inline";
import { Button } from "@/components/ui/button";

// Rename the current database from the workspace's Database pane. A quiet
// "Rename database" button that swaps to the shared inline editor (client
// validation + restart-warning copy live there). On success we navigate to
// the renamed db's pane — the action only revalidates, so the live ?db (keyed
// on the old name) would otherwise fall back to the first database.
//
// Why navigate here rather than redirect() in the action: the inline editor
// runs the action inside a client transition wrapped in try/catch, which
// would swallow Next's NEXT_REDIRECT. A full-page assign matches how the
// DatabaseStrip switches databases.

export function RenameDatabaseControl({
  connectionId,
  name,
  action,
}: {
  connectionId: string;
  name: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <RenameDatabaseInline
        connectionId={connectionId}
        initialName={name}
        action={action}
        onDone={(result) => {
          setEditing(false);
          if (result?.newName && result.newName !== name) {
            const url = new URL(window.location.href);
            url.searchParams.set("db", result.newName);
            url.searchParams.set("section", "database");
            window.location.assign(url.toString());
          }
        }}
      />
    );
  }

  return (
    <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
      Rename database
    </Button>
  );
}
