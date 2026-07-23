"use client";

import Link from "next/link";
import { Database } from "lucide-react";

// Type-only, and from the pure /policy subpath (CLAUDE.md client-import rule):
// the root entrypoint pulls the Node-only `postgres` driver. The inline
// `{ type X }` form keeps the module in the graph, and Turbopack (Next 16's
// default bundler) hard-errors on the driver where webpack was lenient.
import type { TableAccessPolicy } from "@midplane-cloud/db/policy";

// Type-only import — `@/lib/projects` re-exports `getDb` which pulls
// in the `postgres` driver (Node-only). `import type` erases at compile
// time so the client bundle stays clean. See CLAUDE.md "Client-component
// imports from @midplane-cloud/db".
import type { SafeProjectDatabase } from "@/lib/projects";

import { StatusDot } from "@/components/dashboard/status-dot";
import {
  useProjectFreshness,
  useDatabaseLastQuery,
} from "@/components/dashboard/freshness-provider";
import { lastQueryLabel } from "@/lib/format";
import {
  resolveServing,
  SERVING_COLORS,
  SERVING_LABELS,
} from "@/lib/freshness";
import { accessLabel } from "@/lib/policy-labels";

// One database row inside a project card on the dashboard list. Read-only:
// it links into that database's pane in the project workspace, where
// rename / remove / rotate / policy all live now. The list identifies and
// routes; the workspace manages. Live status still updates in place (the
// dot color from the project's serving state, the per-DB last-query meta) via
// the dashboard freshness provider, falling back to server-rendered values
// until the first poll.
//
// `relative z-10` lifts the row above the card's stretched open-link (the
// project name's ::after covers the whole card) so clicking a DB navigates
// to that DB, while clicking empty card chrome opens the project.

export function DatabaseRow({
  projectId,
  database,
  initialLastQueryAt,
  initialPausedAt,
}: {
  projectId: string;
  // Use the safe projection — never the full row. The full row includes
  // `encryptedDsn: Uint8Array` which Next 15 refuses to serialize across
  // the Server→Client boundary, and the upstream readers (e.g.
  // listDashboardProjects) project sensitive columns away by default.
  database: Pick<SafeProjectDatabase, "name" | "tableAccess">;
  /** Server-rendered fallback for the per-DB last-query timestamp.
   *  Used until the freshness provider has data for this project. */
  initialLastQueryAt: Date | null;
  /** Server-rendered fallback for the parent project's paused state —
   *  when set, the row dot reads "paused" (the whole project is gated,
   *  so every DB on it is too). */
  initialPausedAt: Date | null;
}) {
  const policy = database.tableAccess as TableAccessPolicy;
  const tableCount = Object.keys(policy.tables ?? {}).length;

  // Live serving state — falls back to server-rendered values until the
  // first poll returns. A rendered row implies the project has ≥1 database,
  // so serving is only ever "ready" or "paused" here (never the no-database
  // "broken" state). The per-DB lastQueryAt drives the meta line.
  const liveConn = useProjectFreshness(projectId);
  const pausedAt = liveConn ? liveConn.pausedAt : initialPausedAt;
  const { state: serving } = resolveServing({ pausedAt, databaseCount: 1 });
  const liveLastQuery = useDatabaseLastQuery(projectId, database.name);
  const lastQueryAt = liveConn ? liveLastQuery : initialLastQueryAt;
  const lastQueryText = lastQueryLabel(lastQueryAt); // shared copy — lib/format.ts

  return (
    <li className="relative z-10">
      <Link
        href={`/projects/${projectId}?db=${encodeURIComponent(database.name)}&section=database`}
        className="flex min-h-[44px] items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/40"
      >
        <StatusDot
          colorClass={SERVING_COLORS[serving]}
          pulse={serving === "ready"}
          label={SERVING_LABELS[serving]}
        />
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
