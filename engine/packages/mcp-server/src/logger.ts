// pino instance for ops logging. NEVER used for audit — audit goes through
// engine.audit only (per "Code Quality Decisions" lock).

import pino from "pino";

export const logger = pino(
  {
    // Silent during tests by default; ops logging in production.
    level:
      process.env.LOG_LEVEL ??
      (process.env.NODE_ENV === "test" || process.env.BUN_TEST ? "silent" : "info"),
    base: { service: "midplane-mcp-server" },
  },
  // stderr, NOT pino's default stdout. Under the stdio transport, stdout IS the
  // MCP channel: the client parses it as line-delimited JSON-RPC, so a single
  // ops log line there is a protocol error. `{"level":30,...,"msg":"starting
  // mcp-server"}` is valid JSON but not a JSON-RPC message, and the SDK's
  // transport rejects it with a zod invalid_union before the session is even up.
  //
  // Unconditional rather than transport-conditional on purpose. The transport is
  // only known after loadConfig, this module is a singleton constructed at first
  // import, and making correctness depend on that import landing after the config
  // read is a trap waiting for the next refactor. Ops logs are not program
  // output; stderr is where they belong on either transport. Nothing regressed by
  // the move: `docker logs` and Fly capture both streams, and ProcessSpawner
  // drains stdout and stderr into one buffer.
  pino.destination(2),
);

export type Logger = typeof logger;
