#!/usr/bin/env bun
// `midplane` — unified CLI entrypoint.
//
// Subcommands:
//   server (default)   Run the MCP server (stdio or HTTP). Same code path as
//                      the legacy `midplane-mcp-server` bin.
//   init               Interactive setup wizard: introspect the DB, detect
//                      the tenant column, write a validated policy file.
//   query              Send one query through a running server exactly as an
//                      agent would (MCP client; verification, not a psql).
//   doctor             Preflight + smoke checks (config, policy, DB, audit,
//                      /health, end-to-end canary).
//   audit              Read the local audit log
//                      (tail | since | denies | show | stats).
//   policy             Author/validate/lint/dry-run a MIDPLANE_POLICY_FILE
//                      (init | validate | lint | test [--server]).
//   version            Print the package version.
//   help               Show usage.
//
// Lives alongside the server bin rather than as a separate package because it
// shares the engine workspace; one binary on PATH inside the container is the
// whole point. Interactive/client-side imports (@clack/prompts, the MCP
// client) load lazily so the server path never pays for them.

import { runAudit, printAuditHelp } from "./audit-cli.ts";
import { runPolicy, printPolicyHelp } from "./policy-cli.ts";
import { version as PACKAGE_VERSION } from "../package.json" with { type: "json" };

// `midplane audit tail | head` must exit cleanly when the consumer closes
// the pipe, not crash with an EPIPE stack trace — closed-pipe is the normal
// end of life for a streaming CLI.
function exitOnEpipe(err: NodeJS.ErrnoException): void {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
}
process.stdout.on("error", exitOnEpipe);
process.stderr.on("error", exitOnEpipe);

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
    case "policy":
      await runPolicy(rest);
      return;
    case "query": {
      // Lazy: pulls in the MCP client SDK, which `server`/`audit`/`policy`
      // never need.
      const { runQuery } = await import("./query-cli.ts");
      await runQuery(rest);
      return;
    }
    case "doctor": {
      const { runDoctor } = await import("./doctor-cli.ts");
      await runDoctor(rest);
      return;
    }
    case "init": {
      // Lazy: @clack/prompts (and pg) stay out of every non-wizard path.
      const { runInit } = await import("./init-wizard.ts");
      await runInit(rest);
      return;
    }
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
      if (rest[0] === "policy") {
        printPolicyHelp();
        return;
      }
      if (rest[0] === "query") {
        const { printQueryHelp } = await import("./query-cli.ts");
        printQueryHelp();
        return;
      }
      if (rest[0] === "doctor") {
        const { printDoctorHelp } = await import("./doctor-cli.ts");
        printDoctorHelp();
        return;
      }
      if (rest[0] === "init") {
        const { printInitHelp } = await import("./init-wizard.ts");
        printInitHelp();
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
  midplane [server]    Run the MCP server (default subcommand)
  midplane init        Interactive setup: introspect the DB, write a policy
  midplane query ...   Send one query through the server as an agent would
  midplane doctor      Preflight + smoke checks (config, DB, audit, canary)
  midplane audit ...   Read the local audit log
                       (tail | since | denies | show | stats)
  midplane policy ...  Author/validate/lint/dry-run a policy file
                       (init | validate | lint | test [--server])
  midplane version     Print version
  midplane help [cmd]  Detailed usage for init|query|doctor|audit|policy
`);
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
  process.stderr.write(`midplane: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
