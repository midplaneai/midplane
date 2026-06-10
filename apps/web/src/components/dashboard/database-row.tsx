"use client";

import Link from "next/link";
import { Database } from "lucide-react";

import { type TableAccessPolicy } from "@midplane-cloud/db";

// Type-only import — `@/lib/connections` re-exports `getDb` which pulls
// in the `postgres` driver (Node-only). `import type` erases at compile
// time so the client bundle stays clean. See CLAUDE.md "Client-component
// imports from @midplane-cloud/db".
import type { SafeConnectionDatabase } from "@/lib/connections";

import { FreshnessDot } from "@/components/dashboard/freshness-dot";
import {
  useConnectionFreshness,
  useDatabaseLastQuery,
} from "@/components/dashboard/freshness-provider";
import { lastQueryLabel } from "@/lib/format";
import { computeFreshness } from "@/lib/freshness";
import { accessLabel } from "@/lib/policy-labels";

// One database row inside a connection card on the dashboard list. Read-only:
// it links into that database's pane in the connection workspace, where
// rename / remove / rotate / policy all live now. The list identifies and
// routes; the workspace manages. Live freshness still updates in place (the
// dot color from the connection cursor, the per-DB last-query meta) via the
// dashboard freshness provider, falling back to server-rendered values until
// the first poll.
//
// `relative z-10` lifts the row above the card's stretched open-link (the
// connection name's ::after covers the whole card) so clicking a DB navigates
// to that DB, while clicking empty card chrome opens the connection.

export function DatabaseRow({
  connectionId,
  database,
  initialLastQueryAt,
  initialLastIndexedAt,
  initialLastErrorAt,
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
}) {
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
  const lastQueryText = lastQueryLabel(lastQueryAt); // shared copy — lib/format.ts

  return (
    <li className="relative z-10">
      <Link
        href={`/connections/${connectionId}?db=${encodeURIComponent(database.name)}&section=database`}
        className="flex min-h-[44px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
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
    </li>
  );
}
