#!/bin/bash
# Standalone repair script for Laminark plugin dependencies
# Can be triggered manually or by the hook handler on dependency errors.
# Exit codes: 0 = healthy or repaired, 1 = repair failed
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPAIR_LOG="$PLUGIN_ROOT/.repair-log"
NEEDS_REPAIR="$PLUGIN_ROOT/.needs-repair"
HEALTHY=true

log_repair() {
  echo "[$(date -Iseconds)] repair: $1" >> "$REPAIR_LOG"
}

log_repair "--- Repair script started ---"

# 1. Check native addon binary exists
if [ ! -f "$PLUGIN_ROOT/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
  log_repair "FAIL: better-sqlite3 native addon missing"
  HEALTHY=false
fi

# 2. Test that better-sqlite3 loads in Node
if $HEALTHY; then
  if ! node -e "require('better-sqlite3')" 2>/dev/null; then
    log_repair "FAIL: better-sqlite3 require() failed"
    HEALTHY=false
  fi
fi

# 3. Verify dist files exist and aren't empty
if [ ! -s "$PLUGIN_ROOT/dist/hooks/handler.js" ]; then
  log_repair "WARN: dist/hooks/handler.js missing or empty"
  # This can't be fixed by reinstalling deps — just log it
fi

if [ ! -s "$PLUGIN_ROOT/dist/index.js" ]; then
  log_repair "WARN: dist/index.js missing or empty"
fi

# 4. Repair if unhealthy
if ! $HEALTHY; then
  log_repair "Repairing: wiping node_modules and reinstalling"

  rm -rf "$PLUGIN_ROOT/node_modules"

  NPM_TMP="$PLUGIN_ROOT/.npm-tmp"
  mkdir -p "$NPM_TMP"

  TMPDIR="$NPM_TMP" npm install --prefix "$PLUGIN_ROOT" --omit=dev --ignore-scripts --silent --cache "$NPM_TMP/cache" 2>>"$REPAIR_LOG"
  npm rebuild --prefix "$PLUGIN_ROOT" better-sqlite3 --silent 2>>"$REPAIR_LOG"
  rm -rf "$NPM_TMP"

  # Verify repair succeeded
  if node -e "require('better-sqlite3')" 2>/dev/null; then
    log_repair "OK: repair succeeded, better-sqlite3 loads"
  else
    log_repair "ERROR: repair failed, better-sqlite3 still broken"
    rm -f "$NEEDS_REPAIR"
    exit 1
  fi
else
  log_repair "OK: all checks passed, no repair needed"
fi

# Clean up marker file
rm -f "$NEEDS_REPAIR"

log_repair "--- Repair script finished ---"
exit 0
