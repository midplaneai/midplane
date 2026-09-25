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
//   gateway            Run as a gateway: enroll with Midplane Cloud, pull
//                      signed policy bundles, enforce them (gateway/run.ts).
//   version            Print the package version.
//   help               Show usage.
//
// Lives alongside the server bin rather than as a separate package because it
// shares the engine workspace; one binary on PATH inside the container is the
// whole point. Interactive/client-side imports (@clack/prompts, the MCP
// client) load lazily so the server path never pays for them.

import { runAudit, printAuditHelp } from "./audit-cli.ts";
import { runPolicy, printPolicyHelp } from "./policy-cli.ts";
import { parseArgs } from "./argv.ts";
import { transportFromFlags } from "./config.ts";
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
      applyTransportFlags(rest);
      const { runServer } = await import("./index.ts");
      await runServer();
      return;
    }
    case "gateway": {
      // Any argument is either a request for help or a mistake. Neither may
      // start the gateway: with MIDPLANE_ENROLL_TOKEN set, starting it spends
      // the one-time token.
      if (rest.length > 0) {
        const wantsHelp = rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h");
        printGatewayHelp(wantsHelp ? process.stdout : process.stderr);
        if (!wantsHelp) process.exit(2);
        return;
      }
      // Lazy: the link client and enrollment code stay off every other path.
      const { runGateway } = await import("./gateway/run.ts");
      await runGateway();
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
      if (rest[0] === "gateway") {
        printGatewayHelp();
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

// Written into process.env rather than threaded into runServer() because
// loadConfig(process.env) is the one input the config layer has, so the flag
// must land where a hand-set MIDPLANE_TRANSPORT would. The flag wins over the
// env var — it is the more specific instruction. See transportFromFlags.
function applyTransportFlags(argv: string[]): void {
  let transport;
  try {
    transport = transportFromFlags(parseArgs(argv).flags);
  } catch (err) {
    process.stderr.write(`midplane server: ${(err as Error).message}\n`);
    process.exit(2);
  }
  if (transport) process.env.MIDPLANE_TRANSPORT = transport;
}

function printHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`midplane — Postgres safety layer for AI agents

Usage:
  midplane [server]    Run the MCP server (default subcommand)
                       --stdio | --http  override MIDPLANE_TRANSPORT
  midplane gateway     Run as a gateway: enroll with Midplane Cloud, enforce its
                       signed policy bundles, serve /mcp on loopback only
                       (MIDPLANE_CLOUD_URL, MIDPLANE_ENROLL_TOKEN, MIDPLANE_MASK_SALT,
                       MIDPLANE_DSN_<id>)
  midplane init        Interactive setup: introspect the DB, write a policy
  midplane query ...   Send one query through the server as an agent would
  midplane doctor      Preflight + smoke checks (config, DB, audit, canary)
  midplane audit ...   Read the local audit log
                       (tail | since | denies | show | stats)
  midplane policy ...  Author/validate/lint/dry-run a policy file
                       (init | validate | lint | test [--server])
  midplane version     Print version
  midplane help [cmd]  Detailed usage for init|query|doctor|audit|policy|gateway
`);
}

function printGatewayHelp(stream: NodeJS.WriteStream = process.stdout): void {
  stream.write(`midplane gateway — run as a customer-hosted gateway for Midplane Cloud

Usage:
  midplane gateway     (takes no arguments; configured by environment)

Enrolls once with a one-time token, then enforces the signed policy bundles
Midplane Cloud publishes. Serves /mcp on loopback only.

Required:
  MIDPLANE_CLOUD_URL          Your region's Midplane Cloud origin
  MIDPLANE_MASK_SALT          ≥ 32 chars, from your secret manager; never sent to the cloud
  MIDPLANE_ENROLL_TOKEN       First boot only (mpe1_…); ignored once enrolled
  MIDPLANE_DSN_<id>           One per database, as shown in Midplane Cloud

Optional:
  MIDPLANE_GATEWAY_STATE_DIR  Key, identity and last policy (image: /data/gateway; persist it)
  MIDPLANE_GATEWAY_NAME       Defaults to the hostname
  MIDPLANE_GATEWAY_POLL_SECONDS  5–3600, default set by Midplane Cloud
  MIDPLANE_HOST / PORT        Loopback address only (default 127.0.0.1) / 8080
  HTTPS_PROXY                 Egress proxy (on Node, also NODE_USE_ENV_PROXY=1)
`);
}

main().catch((err) => {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
  process.stderr.write(`midplane: fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
