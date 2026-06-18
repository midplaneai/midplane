// pino instance for ops logging. NEVER used for audit — audit goes through
// engine.audit only (per "Code Quality Decisions" lock).

import pino from "pino";

export const logger = pino({
  // Silent during tests by default; ops logging in production.
  level:
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === "test" || process.env.BUN_TEST ? "silent" : "info"),
  base: { service: "midplane-mcp-server" },
});

export type Logger = typeof logger;
