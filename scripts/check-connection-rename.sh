#!/usr/bin/env bash
# Regression guard for the connection→project rename (eng-review T1).
#
# Fails if any container-concept "connection" identifier reappears in the
# control plane. The engine/ deployable is project-agnostic by contract and is
# excluded. Legitimate literals — "connection string" (the Postgres DSN),
# "connection pool", "database connection", "refuse the connection",
# ECONNREFUSED — use the word as a plain noun and never match the container
# identifiers below, so this guard has no allowlist to maintain.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Unambiguous container identifiers/strings the rename eliminated. None of these
# are valid literal-DB-connection phrases.
PAT='connectionId|connectionDatabaseId|connection_id|connection_database|ResolvedConnection|resolveConnectionForCustomer|mcpConnectionUrl|ConnectionResolveResult|CONNECTION_PAUSED|CONNECTION_RESUMED|CONNECTION_SECTIONS|MAX_CONNECTION_NAME|connection_(created|paused|deleted|rotated|resumed)|/connections(/|"|$)'

# git grep (not rg/grep -r) so CI needs no extra install AND .gitignore is
# honored — skips .next/ build caches and node_modules, which bundle
# third-party SQL like `connection_id()`. --untracked also catches new
# uncommitted drift. -a forces text on lib/projects.ts (one control byte).
# engine/ is a sibling of these paths, so it's excluded by the pathspec.
if hits=$(git grep --untracked -aEn "$PAT" -- \
      apps packages infra scripts \
      ':!scripts/check-connection-rename.sh' 2>/dev/null); then
  echo "✗ connection→project rename drift — container 'connection' identifiers reappeared:"
  echo "$hits"
  echo ""
  echo "The container is named 'project'. Use projectId / project_database_id /"
  echo "ResolvedProject / PROJECT_PAUSED / project_* events / /projects. Only literal"
  echo "DB-connection nouns ('connection string', 'connection pool') keep the old word."
  exit 1
fi

echo "✓ no connection→project rename drift"
