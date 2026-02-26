#!/bin/bash
# Update Laminark to the latest version
# Updates the npm package and syncs to the plugin cache

set -e

echo "Laminark Updater"
echo "================"
echo ""

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"

# Check if npm is available
if ! command -v npm &> /dev/null; then
  echo "Error: npm not found"
  exit 1
fi

# Check if installed
CURRENT_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "")
if [ -z "$CURRENT_VERSION" ]; then
  echo "Laminark is not installed globally."
  echo "Run: ./plugin/scripts/install.sh"
  exit 1
fi

echo "Currently installed: v$CURRENT_VERSION"
echo ""
echo "Updating npm package..."
npm update -g laminark

NEW_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "unknown")

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  echo "✓ Already at latest version: v$NEW_VERSION"
else
  echo "✓ npm updated: v$CURRENT_VERSION → v$NEW_VERSION"

  # Sync updated files to plugin cache
  NPM_GLOBAL_ROOT=$(npm root -g)
  PLUGIN_SRC="$NPM_GLOBAL_ROOT/laminark/plugin"
  CACHE_DIR="$CLAUDE_HOME/plugins/cache/laminark/laminark/$NEW_VERSION"

  if [ -d "$PLUGIN_SRC" ]; then
    echo ""
    echo "Syncing to plugin cache..."

    # Remove old version directories (keep data)
    for OLD_DIR in "$CLAUDE_HOME/plugins/cache/laminark/laminark"/*/; do
      [ -d "$OLD_DIR" ] || continue
      OLD_VERSION=$(basename "$OLD_DIR")
      if [ "$OLD_VERSION" != "$NEW_VERSION" ] && [ ! -L "${OLD_DIR%/}" ]; then
        rm -rf "$OLD_DIR"
        echo "  Removed old cache: v$OLD_VERSION"
      fi
    done

    mkdir -p "$CACHE_DIR"
    rsync -a --delete \
      --exclude '*.db' \
      --exclude '*.db-wal' \
      --exclude '*.db-shm' \
      --exclude '.repair-log' \
      --exclude '.npm-tmp' \
      "$PLUGIN_SRC/" "$CACHE_DIR/"

    # Update installed_plugins.json
    INSTALLED_FILE="$CLAUDE_HOME/plugins/installed_plugins.json"
    if [ -f "$INSTALLED_FILE" ]; then
      node -e '
const fs = require("fs");
const path = process.argv[1];
const version = process.argv[2];
let data = JSON.parse(fs.readFileSync(path, "utf8"));
if (data.plugins.laminark) {
  data.plugins.laminark.version = version;
}
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
' "$INSTALLED_FILE" "$NEW_VERSION"
    fi

    echo "✓ Plugin cache updated to v$NEW_VERSION"
  fi
fi

echo ""
echo "Restart your Claude Code session for changes to take effect."

exit 0
