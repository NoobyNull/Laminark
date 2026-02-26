#!/bin/bash
# Uninstall Laminark: remove plugin from cache, settings, and npm

set -e

echo "Laminark Uninstaller"
echo "===================="
echo ""

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"

# Check what's installed
NPM_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "")
CACHE_EXISTS=false
if [ -d "$CLAUDE_HOME/plugins/cache/laminark" ]; then
  CACHE_EXISTS=true
fi

if [ -n "$NPM_VERSION" ]; then
  echo "npm package: v$NPM_VERSION"
fi
if [ "$CACHE_EXISTS" = true ]; then
  echo "Plugin cache: present"
fi

echo ""

# Ask for confirmation
read -p "Are you sure you want to uninstall Laminark? (y/N): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Uninstall cancelled."
  exit 0
fi

# Step 1: Remove plugin from cache
if [ "$CACHE_EXISTS" = true ]; then
  echo ""
  echo "Removing plugin from cache..."
  rm -rf "$CLAUDE_HOME/plugins/cache/laminark"
  echo "✓ Plugin cache removed"
fi

# Step 2: Remove from installed_plugins.json
INSTALLED_FILE="$CLAUDE_HOME/plugins/installed_plugins.json"
if [ -f "$INSTALLED_FILE" ]; then
  node -e '
const fs = require("fs");
const path = process.argv[1];
let data = JSON.parse(fs.readFileSync(path, "utf8"));
delete data.plugins.laminark;
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
' "$INSTALLED_FILE" 2>/dev/null || true
  echo "✓ Plugin registration removed"
fi

# Step 3: Remove from settings
SETTINGS_FILE="$CLAUDE_HOME/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  echo ""
  echo "Cleaning up settings..."
  node -e '
const fs = require("fs");
const settingsPath = process.argv[1];
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));

// Remove enabledPlugins entry
if (settings.enabledPlugins) {
  for (const key of Object.keys(settings.enabledPlugins)) {
    if (key.includes("laminark")) {
      delete settings.enabledPlugins[key];
    }
  }
  if (Object.keys(settings.enabledPlugins).length === 0) {
    delete settings.enabledPlugins;
  }
}

// Remove any legacy manual hooks
if (settings.hooks) {
  for (const [event, entries] of Object.entries(settings.hooks)) {
    settings.hooks[event] = entries.filter(entry =>
      !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes("laminark")))
    );
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
}

// Remove legacy MCP registration
if (settings.mcpServers && settings.mcpServers.laminark) {
  delete settings.mcpServers.laminark;
  if (Object.keys(settings.mcpServers).length === 0) {
    delete settings.mcpServers;
  }
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
' "$SETTINGS_FILE"
  echo "✓ Settings cleaned up"
fi

# Step 4: Remove legacy MCP registration if present
if command -v claude &> /dev/null; then
  if claude mcp list 2>/dev/null | grep -q "^laminark:"; then
    claude mcp remove laminark -s user 2>/dev/null || true
    echo "✓ Legacy MCP registration removed"
  fi
fi

# Step 5: Uninstall npm package
if [ -n "$NPM_VERSION" ]; then
  echo ""
  echo "Uninstalling npm package..."
  npm uninstall -g laminark
  echo "✓ npm package removed"
fi

# Step 6: Optional data cleanup
echo ""
echo "Data cleanup options:"
echo "  1. Keep all data (can reinstall later without losing memories)"
echo "  2. Remove everything (all memories and data)"
echo ""
read -p "Choose option (1-2, default=1): " -n 1 -r CLEANUP_OPTION
echo ""

case $CLEANUP_OPTION in
  2)
    # Check both possible data locations
    for DATA_DIR in "$HOME/.laminark" "$CLAUDE_HOME/plugins/cache/laminark"; do
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
    done
    ;;
  *)
    echo "Keeping all data."
    ;;
esac

echo ""
echo "✓ Uninstall complete!"
echo ""
echo "To reinstall: curl -fsSL https://raw.githubusercontent.com/NoobyNull/Laminark/master/plugin/scripts/install.sh | bash"

exit 0
