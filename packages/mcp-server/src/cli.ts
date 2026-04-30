#!/usr/bin/env bun
// `midplane` — unified CLI entrypoint.
//
// Subcommands:
//   server (default)   Run the MCP server (stdio or HTTP). Same code path as
//                      the legacy `midplane-mcp-server` bin.
//   audit              Read the local audit log (tail | stats | since).
//   version            Print the package version.
//   help               Show usage.
//
// Lives alongside the server bin rather than as a separate package because it
// shares the engine workspace; one binary on PATH inside the container is the
// whole point.

import { runAudit, printAuditHelp } from "./audit-cli.ts";
import { version as PACKAGE_VERSION } from "../package.json" with { type: "json" };

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  switch (cmd) {
    case undefined:
    case "server": {
      const { runServer } = await import("./index.ts");
      await runServer();
      return;
    }
    case "audit":
      await runAudit(rest);
      return;
    case "--version":
    case "-v":
    case "version":
      process.stdout.write(`midplane ${PACKAGE_VERSION}\n`);
      return;
    case "--help":
    case "-h":
    case "help":
      if (rest[0] === "audit") {
        printAuditHelp();
        return;
      }
      printHelp();
      return;
    default:
      process.stderr.write(`midplane: unknown command "${cmd}"\n`);
      printHelp(process.stderr);
      process.exit(2);
  }
}

function printHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`midplane — Postgres safety layer for AI agents

Usage:
  midplane [server]   Run the MCP server (default subcommand)
  midplane audit ...  Read the local audit log (tail | stats | since)
  midplane version    Print version
  midplane help       Show this message

Run 'midplane audit help' for audit subcommands.
`);
}

main().catch((err) => {
  process.stderr.write(`midplane: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
