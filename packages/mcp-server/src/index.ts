#!/usr/bin/env bun
// @midplane/mcp-server — bin entrypoint.
//
// Pipeline: load config → init telemetry → warm parser → build engine →
// build server → pick transport → serve. NEVER touches SQL itself; every
// tool routes through engine.handle().

import { warmup } from "@midplane/engine";
import { loadConfig } from "./config.ts";
import { buildEngine } from "./engine-factory.ts";
import { buildServer } from "./server.ts";
import { startStdio } from "./transport/stdio.ts";
import { startHttp } from "./transport/http.ts";
import { logger } from "./logger.ts";
import { initTelemetry } from "./telemetry/index.ts";
import { version as PACKAGE_VERSION } from "../package.json" with { type: "json" };

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  await warmup();

  const telemetry = initTelemetry({
    dbPath: cfg.dbPath,
    version: PACKAGE_VERSION,
    transport: cfg.transport,
  });

  const handle = buildEngine(cfg, { wrapAudit: (w) => telemetry.wrap(w) });

  let close: () => Promise<void>;

  if (cfg.transport === "stdio") {
    logger.info({ transport: "stdio" }, "starting mcp-server");
    const server = buildServer({ handle, telemetry });
    await startStdio(server);
    close = async () => {
      await telemetry.shutdown();
      await handle.close();
    };
  } else {
    const http = await startHttp(() => buildServer({ handle, telemetry }), {
      port: cfg.port,
      indexer: { audit: handle.audit, token: cfg.indexerToken },
    });
    close = async () => {
      await http.close();
      await telemetry.shutdown();
      await handle.close();
    };
  }

  // Transport is up — only NOW do we tell telemetry to emit the startup
  // event. A failed boot (port-in-use, transport throw) skips this and
  // never produces a "startup ok" signal at the receiver.
  telemetry.markReady();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  main().catch((err) => {
    logger.error({ err }, "fatal");
    process.exit(1);
  });
}
