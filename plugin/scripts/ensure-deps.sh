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

# Auto-provision and auto-update CLAUDE.md with Laminark instructions
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
CLAUDE_MD="$CLAUDE_HOME/CLAUDE.md"
LAMINARK_MD="$PLUGIN_ROOT/CLAUDE.md"
MARKER_START="<!-- laminark:instructions:v"
MARKER_END="<!-- /laminark:instructions -->"

if [ -f "$LAMINARK_MD" ]; then
  NEW_MARKER=$(head -1 "$LAMINARK_MD" | grep -o 'laminark:instructions:v[0-9]*' || echo "")
  mkdir -p "$CLAUDE_HOME"

  if [ ! -f "$CLAUDE_MD" ]; then
    # No CLAUDE.md — create with our instructions
    cp "$LAMINARK_MD" "$CLAUDE_MD"
    log_repair "Created $CLAUDE_MD with Laminark instructions ($NEW_MARKER)"

  elif ! grep -q "$MARKER_START" "$CLAUDE_MD" 2>/dev/null; then
    # CLAUDE.md exists but has no Laminark block — append
    printf '\n' >> "$CLAUDE_MD"
    cat "$LAMINARK_MD" >> "$CLAUDE_MD"
    log_repair "Appended Laminark instructions to $CLAUDE_MD ($NEW_MARKER)"

  elif [ -n "$NEW_MARKER" ]; then
    # Laminark block exists — check if version is current
    CURRENT_MARKER=$(grep -o 'laminark:instructions:v[0-9]*' "$CLAUDE_MD" | head -1 || echo "")
    if [ "$NEW_MARKER" != "$CURRENT_MARKER" ]; then
      # Version mismatch — replace block in-place
      node -e '
const fs = require("fs");
const claudeMd = fs.readFileSync(process.argv[1], "utf8");
const newBlock = fs.readFileSync(process.argv[2], "utf8");
const startMarker = "<!-- laminark:instructions:v";
const endMarker = "<!-- /laminark:instructions -->";
const startIdx = claudeMd.indexOf(startMarker);
const endIdx = claudeMd.indexOf(endMarker);
if (startIdx >= 0 && endIdx >= 0) {
  const before = claudeMd.slice(0, startIdx);
  const after = claudeMd.slice(endIdx + endMarker.length);
  const updated = (before + newBlock + after).replace(/\n{3,}/g, "\n\n").trim() + "\n";
  fs.writeFileSync(process.argv[1], updated);
}
' "$CLAUDE_MD" "$LAMINARK_MD" 2>>"$REPAIR_LOG"
      log_repair "Updated Laminark instructions in $CLAUDE_MD ($CURRENT_MARKER -> $NEW_MARKER)"
    fi
  fi
fi

cd "$PLUGIN_ROOT"
exec "$@"
