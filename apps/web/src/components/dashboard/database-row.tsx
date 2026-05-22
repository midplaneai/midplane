"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Database } from "lucide-react";

import { type TableAccessPolicy } from "@midplane-cloud/db";

// Type-only import — `@/lib/connections` re-exports `getDb` which pulls
// in the `postgres` driver (Node-only). `import type` erases at compile
// time so the client bundle stays clean. See CLAUDE.md "Client-component
// imports from @midplane-cloud/db".
import type { SafeConnectionDatabase } from "@/lib/connections";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DatabaseRowMenu } from "@/components/dashboard/database-row-menu";
import { FreshnessDot } from "@/components/dashboard/freshness-dot";
import {
  useConnectionFreshness,
  useDatabaseLastQuery,
} from "@/components/dashboard/freshness-provider";
import { RenameDatabaseInline } from "@/components/dashboard/rename-database-inline";
import { computeFreshness } from "@/lib/freshness";
import { cn } from "@/lib/utils";

// Container for one DB row inside the dashboard's per-connection list.
// Owns the local UI state for inline rename + remove confirmation +
// the post-confirm fade-out animation. The static parts of the row
// (name link, meta text) stay rendered as a server-passed Link so
// navigation still works without client-side routing churn.
//
// Animation: on confirmed remove we set `removing=true` while the
// server action runs in a transition. motion-safe: max-h + opacity
// fade-out gives a slide-up of siblings; motion-reduce: snap to
// hidden with no transition. Once revalidatePath lands, the row
// unmounts naturally — we don't have to manually unmount.

export function DatabaseRow({
  connectionId,
  database,
  initialLastQueryAt,
  initialLastIndexedAt,
  initialLastErrorAt,
  disableRemove,
  removeAction,
  renameAction,
}: {
  connectionId: string;
  // Use the safe projection — never the full row. The full row includes
  // `encryptedDsn: Uint8Array` which Next 15 refuses to serialize across
  // the Server→Client boundary, and the upstream readers (e.g.
  // listDashboardConnections) project sensitive columns away by default.
  database: Pick<SafeConnectionDatabase, "name" | "tableAccess">;
  /** Server-rendered fallback for the per-DB last-query timestamp.
   *  Used until the freshness provider has data for this connection. */
  initialLastQueryAt: Date | null;
  /** Server-rendered fallback for the connection-level cursor — drives
   *  the row's freshness dot (same dot as the connection header). */
  initialLastIndexedAt: Date | null;
  initialLastErrorAt: Date | null;
  disableRemove: boolean;
  removeAction: (formData: FormData) => Promise<void>;
  renameAction: (formData: FormData) => Promise<void>;
}) {
  const [renameMode, setRenameMode] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const policy = database.tableAccess as TableAccessPolicy;
  const tableCount = Object.keys(policy.tables ?? {}).length;

  // Live freshness — falls back to server-rendered values until the
  // first poll returns. The cursor drives the dot's color; the per-DB
  // lastQueryAt drives the meta line.
  const liveConn = useConnectionFreshness(connectionId);
  const cursor = liveConn?.cursor ?? {
    lastIndexedAt: initialLastIndexedAt,
    lastErrorAt: initialLastErrorAt,
  };
  const freshness = computeFreshness(cursor);
  const liveLastQuery = useDatabaseLastQuery(connectionId, database.name);
  const lastQueryAt = liveConn ? liveLastQuery : initialLastQueryAt;
  const lastQueryText = lastQueryLabel(lastQueryAt);

  function handleConfirmRemove() {
    const fd = new FormData();
    fd.set("connectionId", connectionId);
    fd.set("name", database.name);
    setRemoveError(null);
    setConfirmOpen(false);
    setRemoving(true);
    startTransition(async () => {
      try {
        await removeAction(fd);
        // Action revalidates /dashboard. The row will unmount on next
        // render; the fade-out animation is what the user sees during
        // the transition window.
      } catch (e) {
        setRemoving(false);
        setRemoveError(e instanceof Error ? e.message : "remove failed");
      }
    });
  }

  return (
    <li
      className={cn(
        "group relative flex min-h-[44px] items-center motion-safe:transition-all motion-safe:duration-200 motion-safe:ease-out",
        removing &&
          "pointer-events-none motion-safe:max-h-0 motion-safe:min-h-0 motion-safe:opacity-0 motion-safe:overflow-hidden motion-reduce:hidden",
      )}
      aria-busy={removing || undefined}
    >
      {renameMode ? (
        <RenameDatabaseInline
          connectionId={connectionId}
          initialName={database.name}
          action={renameAction}
          onDone={() => setRenameMode(false)}
        />
      ) : (
        <Link
          href={`/connections/${connectionId}/databases/${database.name}`}
          className="flex flex-1 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
        >
          <FreshnessDot state={freshness} />
          <Database
            className="h-3.5 w-3.5 flex-shrink-0 text-subtle"
            strokeWidth={1.5}
            aria-hidden
          />
          <span className="font-mono text-sm text-foreground">
            {database.name}
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {accessLabel(policy.default)} · {tableCount}{" "}
            {tableCount === 1 ? "table" : "tables"} · {lastQueryText}
          </span>
        </Link>
      )}
      <div className="pr-2">
        <DatabaseRowMenu
          connectionId={connectionId}
          dbName={database.name}
          disableRemove={disableRemove}
          onRename={() => setRenameMode(true)}
          onRemove={() => setConfirmOpen(true)}
        />
      </div>
      {removeError ? (
        <div className="absolute right-12 top-1/2 -translate-y-1/2 text-xs text-destructive">
          {removeError}
        </div>
      ) : null}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove database <span className="font-mono">{database.name}</span>?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The encrypted DSN row is removed and the running session
              respawns without this database. Audit history for past
              queries against it stays in the dashboard for compliance.
              This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRemove}>
              Remove database
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function accessLabel(level: string): string {
  if (level === "read") return "read";
  if (level === "deny") return "deny";
  if (level === "read_write") return "read · write";
  return level;
}

function lastQueryLabel(lastQueryAt: Date | null): string {
  if (!lastQueryAt) return "awaiting first query";
  return `last query ${formatRelative(lastQueryAt)}`;
}

function formatRelative(d: Date): string {
  const ms = Date.now() - d.getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
