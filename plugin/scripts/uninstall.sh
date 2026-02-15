#!/bin/bash
# Uninstall Laminark: remove MCP server, hooks, and npm package

set -e

echo "Laminark Uninstaller"
echo "===================="
echo ""

# Check if claude CLI is available
if ! command -v claude &> /dev/null; then
  echo "Warning: claude CLI not found, skipping MCP/hook cleanup"
  SKIP_CLAUDE=true
fi

# Check what's installed
NPM_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "")
if [ -n "$NPM_VERSION" ]; then
  echo "npm package: v$NPM_VERSION"
fi

# Check MCP registration
if [ "$SKIP_CLAUDE" != "true" ]; then
  if claude mcp list 2>/dev/null | grep -q "laminark"; then
    echo "MCP server: registered"
    MCP_REGISTERED=true
  fi
fi

echo ""

# Ask for confirmation
read -p "Are you sure you want to uninstall Laminark? (y/N): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Uninstall cancelled."
  exit 0
fi

# Step 1: Remove MCP server
if [ "$MCP_REGISTERED" = "true" ]; then
  echo ""
  echo "Removing MCP server..."
  claude mcp remove laminark -s user 2>/dev/null || true
  echo "✓ MCP server removed"
fi

# Step 2: Remove hooks from settings.json
echo ""
echo "Removing hooks from settings..."
SETTINGS_FILE="${CLAUDE_HOME:-$HOME/.claude}/settings.json"

if [ -f "$SETTINGS_FILE" ]; then
  node -e '
const fs = require("fs");
const settingsPath = process.argv[1];

const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

if (settings.hooks) {
  for (const [event, entries] of Object.entries(settings.hooks)) {
    settings.hooks[event] = entries.filter(entry =>
      !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes("laminark")))
    );
    // Remove empty arrays
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  // Remove empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
}

// Remove laminark from enabledPlugins if present
if (settings.enabledPlugins) {
  for (const key of Object.keys(settings.enabledPlugins)) {
    if (key.includes("laminark")) {
      delete settings.enabledPlugins[key];
    }
  }
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
' "$SETTINGS_FILE"
  echo "✓ Hooks removed"
fi

# Step 3: Uninstall npm package
if [ -n "$NPM_VERSION" ]; then
  echo ""
  echo "Uninstalling npm package..."
  npm uninstall -g laminark
  echo "✓ npm package removed"
fi

# Step 4: Optional data cleanup
echo ""
echo "Data cleanup options:"
echo "  1. Keep all data (can reinstall later without losing memories)"
echo "  2. Remove everything (all memories and data)"
echo ""
read -p "Choose option (1-2, default=1): " -n 1 -r CLEANUP_OPTION
echo ""

case $CLEANUP_OPTION in
  2)
    DATA_DIR="$HOME/.laminark"
    if [ -d "$DATA_DIR" ]; then
      echo ""
      echo "WARNING: This will delete all your memories and observations!"
      read -p "Delete $DATA_DIR? (y/N): " -n 1 -r
      echo ""
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$DATA_DIR"
        echo "✓ Data directory removed: $DATA_DIR"
      else
        echo "  Kept data directory: $DATA_DIR"
      fi
    fi
    ;;
  *)
    echo "Keeping all data."
    ;;
esac

echo ""
echo "✓ Uninstall complete!"
echo ""
echo "To reinstall: npm install -g laminark && ./plugin/scripts/install.sh"

exit 0
