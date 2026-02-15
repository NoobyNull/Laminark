#!/bin/bash
# Auto-install production dependencies if missing (first run after plugin install)
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3/build" ]; then
  # Use local tmp dir to avoid EXDEV errors on btrfs subvolumes / cross-device setups
  NPM_TMP="$PLUGIN_ROOT/.npm-tmp"
  mkdir -p "$NPM_TMP"
  # Install deps without running install scripts (sharp build fails without node-addon-api)
  # then selectively rebuild better-sqlite3 which needs its native addon
  TMPDIR="$NPM_TMP" npm install --prefix "$PLUGIN_ROOT" --omit=dev --ignore-scripts --silent --cache "$NPM_TMP/cache" 2>/dev/null
  npm rebuild --prefix "$PLUGIN_ROOT" better-sqlite3 --silent 2>/dev/null
  rm -rf "$NPM_TMP"
fi
cd "$PLUGIN_ROOT"
exec "$@"
