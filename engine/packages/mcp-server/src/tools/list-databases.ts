// list_databases tool — only registered when the registry has more than
// one DB. No args. Returns each configured DB's name plus enough metadata
// for the agent to know whether tenant_scope and table_access defaults
// are in play before issuing a query.

import type { ToolResult } from "./query.ts";
import type { EngineRegistry } from "../engine-factory.ts";

export function handleListDatabases(input: {
  registry: EngineRegistry;
}): ToolResult {
  const databases = input.registry.describe();
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ databases }),
      },
    ],
  };
}
