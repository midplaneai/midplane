#!/usr/bin/env bun
// @midplane/mcp-server — bin entrypoint.
//
// Pipeline: load config → warm parser → build engine → build server →
// pick transport → serve. NEVER touches SQL itself; every tool routes through
// engine.handle().

import { warmup } from "@midplane/engine";
import { loadConfig } from "./config.ts";
import { buildEngine } from "./engine-factory.ts";
import { buildServer } from "./server.ts";
import { startStdio } from "./transport/stdio.ts";
import { startHttp } from "./transport/http.ts";
import { logger } from "./logger.ts";

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }

  await warmup();

  const handle = buildEngine(cfg);

  let close: () => Promise<void>;

  if (cfg.transport === "stdio") {
    logger.info({ transport: "stdio" }, "starting mcp-server");
    const server = buildServer({ handle });
    await startStdio(server);
    close = async () => {
      await handle.close();
    };
  } else {
    const http = await startHttp(() => buildServer({ handle }), { port: cfg.port });
    close = async () => {
      await http.close();
      await handle.close();
    };
  }

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
