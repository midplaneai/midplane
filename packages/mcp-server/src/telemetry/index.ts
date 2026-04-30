// Public telemetry entrypoint. Wires config + collector + sender + heartbeat.
//
// Lifecycle:
//
//   const telemetry = initTelemetry({ cfg, dbPath, version });
//   const audit = telemetry.wrap(new SqliteAuditWriter(dbPath));
//   ...build server, bind transport, await listen success...
//   telemetry.markReady();   // emit startup event + start heartbeat timer
//   ...
//   await telemetry.shutdown();
//
// markReady() is intentionally separate from initTelemetry() so that a boot
// failure (port in use, transport throw, server.connect throw) does NOT
// produce a "successful startup" event. The receiver should see startup
// only when the process is actually ready to accept traffic.
//
// Disabled mode is a true noop: install-id is not generated, no startup
// event is sent, heartbeat is not scheduled, audit writer is returned as-is.

import { existsSync } from "node:fs";
import type { AuditWriter } from "@midplane/engine";
import { loadTelemetryConfig, type TelemetryConfig } from "./config.ts";
import { TelemetryCollector, TelemetryAuditWriter } from "./collector.ts";
import { loadOrCreateInstallId } from "./install-id.ts";
import { createSender, type Sender } from "./sender.ts";
import {
  type StartupEvent,
  type HeartbeatEvent,
  type ToolName,
} from "./schema.ts";

export interface TelemetryHandle {
  wrap(writer: AuditWriter): AuditWriter;
  recordToolCall(name: ToolName, allowed: boolean): void;
  // Call once the transport is listening. Sends the startup event and
  // starts the heartbeat timer. Idempotent — repeat calls are noops so a
  // caller can defensively call from multiple paths without double-sending.
  markReady(): void;
  shutdown(): Promise<void>;
}

export interface InitOptions {
  env?: NodeJS.ProcessEnv;
  cfg?: TelemetryConfig;
  dbPath: string;
  version: string;
  transport: "stdio" | "http";
  noticeStream?: NodeJS.WritableStream;
}

const NOOP_HANDLE: TelemetryHandle = {
  wrap: (w) => w,
  recordToolCall: () => {},
  markReady: () => {},
  async shutdown() {},
};

export function initTelemetry(opts: InitOptions): TelemetryHandle {
  const env = opts.env ?? process.env;
  const cfg = opts.cfg ?? loadTelemetryConfig(env);

  if (cfg.mode === "disabled") {
    return NOOP_HANDLE;
  }

  // Generate / load the install ID. This is the only place a write to the
  // /data volume happens for telemetry. If the volume is not writable, the
  // helper degrades to an in-memory ID and we proceed.
  const installResult = loadOrCreateInstallId(opts.dbPath);
  const installId = installResult.id;

  if (installResult.generated) {
    printFirstRunNotice(opts.noticeStream ?? process.stderr, installResult.path);
  }

  const collector = new TelemetryCollector();
  const sender = createSender(cfg);
  const startedAt = Date.now();

  let ready = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  return {
    wrap(writer) {
      return new TelemetryAuditWriter(writer, collector);
    },
    recordToolCall(name, allowed) {
      collector.recordToolCall(name, allowed);
    },
    markReady() {
      if (ready) return;
      ready = true;

      const startupEvent = buildStartupEvent({
        installId,
        version: opts.version,
        transport: opts.transport,
      });

      // Send after the optional jitter delay so a fleet restart doesn't
      // stampede the receiver. Promise intentionally unawaited.
      void scheduleStartup(sender, startupEvent, cfg.startupDelayMs);

      interval = setInterval(() => {
        void emitHeartbeat({ collector, sender, installId, version: opts.version, startedAt });
      }, cfg.heartbeatMs);
      // Don't keep the process alive just for telemetry.
      if (typeof interval.unref === "function") interval.unref();
    },
    async shutdown() {
      if (interval) clearInterval(interval);
      // Per TELEMETRY.md: the partial window at shutdown is dropped. No
      // shutdown event in v1 — keeps the receiver-side data model simple.
    },
  };
}

async function scheduleStartup(
  sender: Sender,
  event: StartupEvent,
  delayMs: number,
): Promise<void> {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  await sender.send(event);
}

async function emitHeartbeat(args: {
  collector: TelemetryCollector;
  sender: Sender;
  installId: string;
  version: string;
  startedAt: number;
}): Promise<void> {
  const drained = args.collector.drainHeartbeat();
  if (!drained) return;          // idle window — skip
  const event: HeartbeatEvent = {
    schema_version: 2,
    event: "heartbeat",
    install_id: args.installId,
    ts: Math.floor(Date.now() / 1000),
    version: args.version,
    uptime_s: Math.max(0, Math.floor((Date.now() - args.startedAt) / 1000)),
    window_s: drained.window_s,
    tools: drained.tools,
    denials_by_rule: drained.denials_by_rule,
    statement_types: drained.statement_types,
    latency_overhead_ms: drained.latency_overhead_ms,
    exec_failures: drained.exec_failures,
  };
  await args.sender.send(event);
}

function buildStartupEvent(args: {
  installId: string;
  version: string;
  transport: "stdio" | "http";
}): StartupEvent {
  return {
    schema_version: 2,
    event: "startup",
    install_id: args.installId,
    ts: Math.floor(Date.now() / 1000),
    version: args.version,
    bun_version: process.versions.bun ?? "unknown",
    os: detectOs(),
    arch: detectArch(),
    transport: args.transport,
    container: existsSync("/.dockerenv"),
    ci: detectCi(),
  };
}

function detectOs(): StartupEvent["os"] {
  switch (process.platform) {
    case "darwin": return "darwin";
    case "linux":  return "linux";
    case "win32":  return "win32";
    default:       return "other";
  }
}

function detectArch(): StartupEvent["arch"] {
  switch (process.arch) {
    case "x64":   return "x64";
    case "arm64": return "arm64";
    default:      return "other";
  }
}

function detectCi(): boolean {
  const e = process.env;
  return Boolean(
    e.CI === "1" ||
    e.CI === "true" ||
    e.GITHUB_ACTIONS ||
    e.GITLAB_CI ||
    e.CIRCLECI ||
    e.BUILDKITE ||
    e.TRAVIS ||
    e.JENKINS_URL,
  );
}

function printFirstRunNotice(stream: NodeJS.WritableStream, path: string): void {
  stream.write(
    [
      "[midplane] anonymous telemetry is enabled (install ID written to " + path + ").",
      "[midplane] see TELEMETRY.md for what's collected and how to disable.",
      "[midplane] disable: MIDPLANE_TELEMETRY=0  (or DO_NOT_TRACK=1)",
    ].join("\n") + "\n",
  );
}

// Re-exports for callers that want the typed surface.
export type { TelemetryConfig } from "./config.ts";
export type { ToolName } from "./schema.ts";
