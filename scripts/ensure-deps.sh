#!/bin/bash
# Auto-install production dependencies if missing (first run after plugin install)
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  npm install --prefix "$PLUGIN_ROOT" --production --silent 2>/dev/null
fi
exec "$@"
