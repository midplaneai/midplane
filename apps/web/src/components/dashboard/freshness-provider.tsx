"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// Live freshness state for the dashboard. Initialized from the server-
// rendered snapshot, refreshed every POLL_INTERVAL_MS via a fetch to
// /api/dashboard/freshness. Pauses while:
//   - the tab is hidden (document.hidden)
//   - any modal dialog is open (Radix sets data-state="open" on
//     [role="dialog"], which we use as the no-jitter cue from any
//     sheet, alert-dialog, etc. without coupling to specific
//     primitives)
// Resumes on visibilitychange and on the next interval tick.

const POLL_INTERVAL_MS = 60_000;

interface DatabaseFreshness {
  name: string;
  lastQueryAt: Date | null;
}

export interface ConnectionFreshness {
  /** Non-null = paused. Overrides the cursor-derived dot (see
   *  resolveFreshness) so a paused connection reads "paused" on the
   *  dashboard, refreshed on every poll. */
  pausedAt: Date | null;
  cursor: { lastIndexedAt: Date | null; lastErrorAt: Date | null };
  databases: Map<string, DatabaseFreshness>;
}

type Snapshot = Map<string, ConnectionFreshness>;

const FreshnessContext = createContext<Snapshot | null>(null);

interface SerializedSnapshot {
  connections: Array<{
    id: string;
    pausedAt: string | null;
    cursor: {
      lastIndexedAt: string | null;
      lastErrorAt: string | null;
    };
    databases: Array<{
      name: string;
      lastQueryAt: string | null;
    }>;
  }>;
}

export interface FreshnessInitial {
  connections: Array<{
    id: string;
    pausedAt: Date | null;
    cursor: {
      lastIndexedAt: Date | null;
      lastErrorAt: Date | null;
    };
    databases: Array<{
      name: string;
      lastQueryAt: Date | null;
    }>;
  }>;
}

function deserialize(payload: SerializedSnapshot): Snapshot {
  const map: Snapshot = new Map();
  for (const c of payload.connections) {
    const dbs = new Map<string, DatabaseFreshness>();
    for (const d of c.databases) {
      dbs.set(d.name, {
        name: d.name,
        lastQueryAt: d.lastQueryAt ? new Date(d.lastQueryAt) : null,
      });
    }
    map.set(c.id, {
      pausedAt: c.pausedAt ? new Date(c.pausedAt) : null,
      cursor: {
        lastIndexedAt: c.cursor.lastIndexedAt
          ? new Date(c.cursor.lastIndexedAt)
          : null,
        lastErrorAt: c.cursor.lastErrorAt
          ? new Date(c.cursor.lastErrorAt)
          : null,
      },
      databases: dbs,
    });
  }
  return map;
}

function fromInitial(initial: FreshnessInitial): Snapshot {
  const map: Snapshot = new Map();
  for (const c of initial.connections) {
    const dbs = new Map<string, DatabaseFreshness>();
    for (const d of c.databases) {
      dbs.set(d.name, { name: d.name, lastQueryAt: d.lastQueryAt });
    }
    map.set(c.id, {
      pausedAt: c.pausedAt,
      cursor: c.cursor,
      databases: dbs,
    });
  }
  return map;
}

export function DashboardFreshnessProvider({
  initial,
  children,
}: {
  initial: FreshnessInitial;
  children: React.ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => fromInitial(initial));
  // Re-seed from the server snapshot whenever it changes. useState's
  // initializer runs only on mount, so without this a Server Action that
  // calls revalidatePath("/dashboard") — pause/resume, rename, add-db —
  // streams a fresh `initial` that we'd otherwise ignore until the next
  // 60s poll. Consumers prefer the live snapshot over their initial* props
  // (so cross-surface polling wins), which means the snapshot must track
  // revalidations or a just-paused connection keeps reading "live" until a
  // manual refresh. `initial` only gets a new reference on a server
  // re-render — client-side poll updates re-render via setSnapshot without
  // touching the prop, so this doesn't clobber freshly polled data.
  useEffect(() => {
    setSnapshot(fromInitial(initial));
  }, [initial]);
  // Hold the latest setSnapshot in a ref so the polling loop never
  // closes over a stale handle even if React's state batching shifts.
  const inFlightRef = useRef<AbortController | null>(null);

  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    // Skip while any dialog is open — Radix marks open dialogs with
    // data-state="open"; this catches Sheet, AlertDialog, and any
    // future modal without coupling to a specific primitive.
    if (
      typeof document !== "undefined" &&
      document.querySelector('[role="dialog"][data-state="open"]')
    ) {
      return;
    }
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    try {
      const res = await fetch("/api/dashboard/freshness", {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (!res.ok) return;
      const body = (await res.json()) as SerializedSnapshot;
      setSnapshot(deserialize(body));
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      // Swallow transient network errors — next tick retries.
      console.warn("[dashboard] freshness poll failed", err);
    } finally {
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
      }
    }
  }, []);

  useEffect(() => {
    const id = window.setInterval(poll, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      inFlightRef.current?.abort();
    };
  }, [poll]);

  return (
    <FreshnessContext.Provider value={snapshot}>
      {children}
    </FreshnessContext.Provider>
  );
}

/** Read the live freshness for one connection, or `null` when the
 *  provider isn't mounted (caller falls back to its server-rendered
 *  initial values). */
export function useConnectionFreshness(
  connectionId: string,
): ConnectionFreshness | null {
  const snapshot = useContext(FreshnessContext);
  return snapshot?.get(connectionId) ?? null;
}

/** Read the live last-query-at for one DB on a connection. */
export function useDatabaseLastQuery(
  connectionId: string,
  dbName: string,
): Date | null {
  const conn = useConnectionFreshness(connectionId);
  return conn?.databases.get(dbName)?.lastQueryAt ?? null;
}

/** Memoize a derivation off the live snapshot. Skips re-running when
 *  the connectionId / dbName tuple doesn't change AND the underlying
 *  values haven't moved. */
export function useFreshnessMemo<T>(
  connectionId: string,
  derive: (conn: ConnectionFreshness | null) => T,
): T {
  const conn = useConnectionFreshness(connectionId);
  return useMemo(() => derive(conn), [conn, derive]);
}
