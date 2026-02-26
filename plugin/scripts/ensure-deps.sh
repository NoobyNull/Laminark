#!/bin/bash
# Auto-install production dependencies if missing (first run after plugin install)
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPAIR_LOG="$PLUGIN_ROOT/.repair-log"

log_repair() {
  echo "[$(date -Iseconds)] ensure-deps: $1" >> "$REPAIR_LOG"
}

verify_better_sqlite3() {
  node -e "require('better-sqlite3')" 2>/dev/null
}

if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3/build" ]; then
  # Use local tmp dir to avoid EXDEV errors on btrfs subvolumes / cross-device setups
  NPM_TMP="$PLUGIN_ROOT/.npm-tmp"
  mkdir -p "$NPM_TMP"

  log_repair "Dependencies missing, running npm install"

  # Install deps without running install scripts (sharp build fails without node-addon-api)
  # then selectively rebuild better-sqlite3 which needs its native addon
  TMPDIR="$NPM_TMP" npm install --prefix "$PLUGIN_ROOT" --omit=dev --ignore-scripts --silent --cache "$NPM_TMP/cache" 2>>"$REPAIR_LOG"
  npm rebuild --prefix "$PLUGIN_ROOT" better-sqlite3 --silent 2>>"$REPAIR_LOG"
  rm -rf "$NPM_TMP"

  # Verify that better-sqlite3 actually loads
  if ! verify_better_sqlite3; then
    log_repair "WARN: better-sqlite3 failed to load after install, retrying with clean node_modules"
    rm -rf "$PLUGIN_ROOT/node_modules"
    NPM_TMP="$PLUGIN_ROOT/.npm-tmp"
    mkdir -p "$NPM_TMP"
    TMPDIR="$NPM_TMP" npm install --prefix "$PLUGIN_ROOT" --omit=dev --ignore-scripts --silent --cache "$NPM_TMP/cache" 2>>"$REPAIR_LOG"
    npm rebuild --prefix "$PLUGIN_ROOT" better-sqlite3 --silent 2>>"$REPAIR_LOG"
    rm -rf "$NPM_TMP"

    if verify_better_sqlite3; then
      log_repair "OK: better-sqlite3 loaded after clean reinstall"
    else
      log_repair "ERROR: better-sqlite3 still fails after clean reinstall"
    fi
  else
    log_repair "OK: better-sqlite3 verified successfully"
  fi
fi

cd "$PLUGIN_ROOT"
exec "$@"
