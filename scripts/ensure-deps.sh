#!/bin/bash
# Auto-install production dependencies if missing (first run after plugin install)
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  # Use local tmp dir to avoid EXDEV errors on btrfs subvolumes / cross-device setups
  NPM_TMP="$PLUGIN_ROOT/.npm-tmp"
  mkdir -p "$NPM_TMP"
  TMPDIR="$NPM_TMP" npm install --prefix "$PLUGIN_ROOT" --production --silent --cache "$NPM_TMP/cache" 2>/dev/null
  rm -rf "$NPM_TMP"
fi
cd "$PLUGIN_ROOT"
exec "$@"
