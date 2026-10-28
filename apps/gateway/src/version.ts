// The gateway's name and version, in a module of their own: the ACME client
// names itself with them, and the relay's bundle takes that client without
// the MCP server (it gives this module the version it was built with).

import { createRequire } from "node:module";

export const SERVER_NAME = "midplane";
/** The package's version: package.json sits one level up from src/ and bundle/ alike. */
export const SERVER_VERSION: string = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;
