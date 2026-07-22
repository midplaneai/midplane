"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { StatusDot } from "@/components/dashboard/status-dot";
import { formatRelative } from "@/lib/format";

// Live confirmation strip for the project Connect pane (support-channels-
// onboarding Day 2): "waiting for your agent…" → "agent connected" → the
// decision-aware first-query confirmation → a live steady-state ("agent
// connected · N queries · last query …"). Polls /api/projects/[id]/connect-
// status (the freshness-provider pattern: pause while the tab is hidden or a
// dialog is open, abort in-flight on unmount), fast while the user is wiring
// their agent then decayed. It never freezes: the steady-state keeps polling
// so the "last query" clock stays live instead of pinning to the first query
// forever.
//
// Expected latency, by design: connect confirmation within one poll (~5s,
// direct DB write at consent); first-query confirmation worst case ~10s
// (poll interval + the audit indexer's 5s tick). A denied first query is the
// product working, not a failure — the copy must not mislabel it.
//
// Wire types are declared inline (not imported from the server-only
// lib/connect-status) per the client-import rule — see consent-form.tsx.
// KEEP IN LOCKSTEP with ConnectPhase / SerializedConnectStatus in
// lib/connect-status.ts — the fetch cast below hides any drift.

type Phase =
  | "waiting"
  | "connected"
  | "connected_no_databases"
  | "first_query"
  | "active";

export interface ConnectLiveStatusPayload {
  phase: Phase;
  grantedDatabases: number;
  queryCount: number;
  firstQuery: { decision: "allow" | "deny"; at: string } | null;
  lastQuery: { at: string } | null;
}

// Eager while the user is actively wiring their agent (the design doc's ~5s
// connect / ~10s first-query bounds), then decayed — a Connect pane left open
// on a project that never gets a query must not poll at activation cadence
// forever. Terminal state stops polling entirely.
const FAST_POLL_MS = 4_000;
const SLOW_POLL_MS = 15_000;
const FAST_WINDOW_MS = 3 * 60_000;

export function ConnectLiveStatus({
  projectId,
  initial,
  auditHref,
}: {
  projectId: string;
  initial: ConnectLiveStatusPayload;
  /** Audit-log link for the terminal states — null for members (the audit
   *  log is an owner/admin surface; a member gets the confirmation without
   *  a link into a page that would only show a restricted notice). */
  auditHref: string | null;
}) {
  const [status, setStatus] = useState<ConnectLiveStatusPayload>(initial);
  // Ticking clock for the steady-state "last query …" label, so the relative
  // time advances between polls, not only when a fresh payload lands.
  const [now, setNow] = useState(() => new Date());
  const inFlightRef = useRef<AbortController | null>(null);
  // Server-requested backoff (429 retry-after). One-shot: consumed by the
  // next scheduling decision, so the limiter actually sheds load instead of
  // every capped tab re-polling at full cadence forever.
  const retryAfterMsRef = useRef<number | null>(null);

  const poll = useCallback(async () => {
    if (typeof document !== "undefined" && document.hidden) return;
    // Skip while any dialog is open (Radix marks them data-state="open") —
    // same no-jitter cue the dashboard freshness poll uses.
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
      const res = await fetch(`/api/projects/${projectId}/connect-status`, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      if (res.status === 429) {
        const retryAfterS = Number(res.headers.get("retry-after"));
        retryAfterMsRef.current =
          Number.isFinite(retryAfterS) && retryAfterS > 0
            ? retryAfterS * 1000
            : SLOW_POLL_MS;
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as ConnectLiveStatusPayload;
      setStatus(body);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      // Swallow transient network errors — next tick retries.
      console.warn("[connect-status] poll failed", err);
    } finally {
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
      }
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const mountedAt = Date.now();
    const tick = async () => {
      if (cancelled) return;
      await poll();
      if (cancelled) return;
      const backoff = retryAfterMsRef.current;
      retryAfterMsRef.current = null;
      const interval =
        backoff ??
        (Date.now() - mountedAt < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS);
      timer = window.setTimeout(tick, interval);
    };
    timer = window.setTimeout(tick, FAST_POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      inFlightRef.current?.abort();
    };
  }, [poll]);

  // Advance the relative-time clock every 30s, independent of polling (which
  // decays to 15s and pauses when the tab is hidden). Cheap setState; the
  // browser throttles the timer while the tab is hidden anyway.
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const view = resolveView(status, now);

  return (
    <section className="border border-border bg-card px-4 py-3">
      <div className="font-mono text-[11px] lowercase tracking-[0.04em] text-subtle">
        agent status
      </div>
      <div className="mt-2 flex items-start gap-2.5" aria-live="polite">
        <StatusDot
          className="mt-[5px] shrink-0"
          colorClass={view.dotClass}
          pulse={view.pulse}
          label={view.srLabel}
        />
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-foreground">{view.headline}</p>
          {view.sub ? (
            // suppressHydrationWarning: the steady-state sub carries a relative
            // "last query …" time whose server-render value can differ from the
            // client's by the time hydration runs — a cosmetic minute-boundary
            // delta the ticking clock corrects on the next frame.
            <p
              className="text-xs text-muted-foreground"
              suppressHydrationWarning
            >
              {view.sub}
            </p>
          ) : null}
          {view.auditLabel && auditHref ? (
            <p className="text-xs">
              <Link
                href={auditHref}
                className="text-[hsl(var(--brand))] underline underline-offset-2"
              >
                {view.auditLabel} →
              </Link>
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

interface StatusView {
  dotClass: string;
  pulse: boolean;
  srLabel: string;
  headline: string;
  sub: string | null;
  /** Label for the audit-log link; null when the state has none. */
  auditLabel: string | null;
}

function resolveView(status: ConnectLiveStatusPayload, now: Date): StatusView {
  // Steady-state: the project has queried more than once. Leave the first-query
  // milestone behind for a live "connected · N queries · last query …" line
  // that keeps ticking — never the frozen first-query banner.
  if (status.phase === "active" && status.lastQuery) {
    const n = status.queryCount;
    return {
      dotClass: "text-[hsl(var(--allow))]",
      pulse: false,
      srLabel: "agent connected and querying",
      headline: "Agent connected",
      sub: `${n} ${n === 1 ? "query" : "queries"} · last query ${formatRelative(
        new Date(status.lastQuery.at),
        now,
      )}.`,
      auditLabel: "View the audit log",
    };
  }
  if (status.phase === "first_query" && status.firstQuery) {
    if (status.firstQuery.decision === "deny") {
      return {
        dotClass: "text-[hsl(var(--deny))]",
        pulse: false,
        srLabel: "first query denied by policy",
        headline: "First query received — denied by policy",
        sub: "Your agent connected and Midplane enforced your policy. A denied first query means the guardrails are working — loosen the policy if the agent should have been allowed.",
        auditLabel: "See why in the audit log",
      };
    }
    return {
      dotClass: "text-[hsl(var(--allow))]",
      pulse: false,
      srLabel: "first query allowed",
      // Decision-axis copy on purpose: "allowed" is the policy verdict, not
      // a claim the execution succeeded (an allowed query can still fail at
      // the customer DB — the audit log shows the outcome).
      headline: "First query allowed",
      sub: "Your agent is connected and policy allowed its first query — the result is in the audit log.",
      auditLabel: "View it in the audit log",
    };
  }
  if (status.phase === "connected_no_databases") {
    return {
      dotClass: "text-[hsl(var(--warn))]",
      pulse: false,
      srLabel: "connected, no databases granted",
      headline: "Agent connected — no databases granted",
      sub: "The sign-in finished without granting any database, so every query is refused. Connect again from your client and grant a database to continue.",
      auditLabel: null,
    };
  }
  if (status.phase === "connected") {
    // Granted-count context only when OAuth grants exist — a machine-token
    // connection has no OAuth grant rows and "0 databases granted" would
    // read as the warning state.
    const granted =
      status.grantedDatabases > 0
        ? `${status.grantedDatabases} ${status.grantedDatabases === 1 ? "database" : "databases"} granted. `
        : "";
    return {
      dotClass: "text-[hsl(var(--allow))]",
      pulse: true,
      srLabel: "agent connected",
      headline: "Agent connected",
      sub: `${granted}Waiting for its first query — confirmation appears here within seconds of the agent running one.`,
      auditLabel: null,
    };
  }
  return {
    dotClass: "text-subtle",
    pulse: true,
    srLabel: "waiting for an agent",
    headline: "Waiting for your agent to connect…",
    sub: "Add the server to your MCP client below and sign in — this updates automatically.",
    auditLabel: null,
  };
}
