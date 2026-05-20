#!/usr/bin/env bun
// @midplane/mcp-server — bin entrypoint.
//
// Pipeline: load config → init telemetry → warm parser → build engine →
// build server → pick transport → serve. NEVER touches SQL itself; every
// tool routes through engine.handle().

import type { AuditWriter } from "@midplane/engine";
import { warmup } from "@midplane/engine";
import { loadConfig } from "./config.ts";
import { buildEngine } from "./engine-factory.ts";
import { buildServer } from "./server.ts";
import { startStdio } from "./transport/stdio.ts";
import { startHttp } from "./transport/http.ts";
import { logger } from "./logger.ts";
import { initTelemetry } from "./telemetry/index.ts";
import {
  DenyWebhookAuditWriter,
  loadDenyWebhookConfig,
} from "./deny-webhook.ts";
import { version as PACKAGE_VERSION } from "../package.json" with { type: "json" };

export async function runServer(): Promise<void> {
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

  let denyWebhook;
  try {
    denyWebhook = loadDenyWebhookConfig(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
  if (denyWebhook) {
    logger.info(
      {
        rules:
          denyWebhook.rules && denyWebhook.rules.size > 0
            ? [...denyWebhook.rules]
            : "all",
      },
      "deny webhook enabled",
    );
  }

  const wrapAudit = (w: AuditWriter): AuditWriter => {
    let result = telemetry.wrap(w);
    if (denyWebhook) result = new DenyWebhookAuditWriter(result, denyWebhook);
    return result;
  };
  const handle = buildEngine(cfg, { wrapAudit });

  let close: () => Promise<void>;

  if (cfg.transport === "stdio") {
    logger.info({ transport: "stdio", databases: handle.registry.names() }, "starting mcp-server");
    // stdio has no HTTP headers — no X-Midplane-Token-Id channel. Pass
    // an empty sessionContext so the field is well-defined null on
    // audit rows from stdio sessions (matches the spec: only MCP
    // sessions opened over HTTP through the cloud proxy carry a token id).
    const server = buildServer({
      handle,
      telemetry,
      sessionContext: { mcp_token_id: null },
    });
    await startStdio(server);
    close = async () => {
      await telemetry.shutdown();
      await handle.close();
    };
  } else {
    const http = await startHttp(
      (sessionContext) =>
        buildServer({ handle, telemetry, sessionContext }),
      {
        port: cfg.port,
        indexer: { audit: handle.registry.audit, token: cfg.indexerToken },
        admin: { setPolicy: (yaml) => handle.registry.setPolicy(yaml) },
      },
    );
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
  runServer().catch((err) => {
    logger.error({ err }, "fatal");
    process.exit(1);
  });
}
