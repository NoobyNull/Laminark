#!/bin/bash
# Install Laminark as a Claude Code plugin
#
# Installs the npm package globally, then copies the plugin directory
# into the Claude Code plugin cache so hooks, MCP servers, and skills
# are all managed by the plugin system automatically.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/NoobyNull/Laminark/master/plugin/scripts/install.sh | bash
#   or:  ./plugin/scripts/install.sh

set -e

echo "Laminark Installer"
echo "=================="
echo ""

# Check prerequisites
if ! command -v node &> /dev/null; then
  echo "Error: node not found"
  echo "Please install Node.js >= 22: https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Error: Node.js >= 22 required (found v$(node -v))"
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "Error: npm not found"
  exit 1
fi

if ! command -v claude &> /dev/null; then
  echo "Error: claude CLI not found"
  echo "Please install Claude Code first: https://claude.com/claude-code"
  exit 1
fi

# Check if already installed
CURRENT_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "")
if [ -n "$CURRENT_VERSION" ]; then
  echo "Currently installed: v$CURRENT_VERSION"
  echo "Reinstalling..."
fi

# Step 1: Install via npm (gets the files onto disk)
echo ""
echo "Installing laminark globally via npm..."
npm install -g laminark
echo "✓ npm package installed"

# Step 2: Locate the installed plugin directory
NPM_GLOBAL_ROOT=$(npm root -g)
PLUGIN_SRC="$NPM_GLOBAL_ROOT/laminark/plugin"

if [ ! -d "$PLUGIN_SRC" ]; then
  echo "Error: Plugin directory not found at $PLUGIN_SRC"
  echo "npm install may have failed."
  exit 1
fi

# Step 3: Copy plugin into Claude Code plugin cache
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
NEW_VERSION=$(grep '"version"' "$NPM_GLOBAL_ROOT/laminark/package.json" | head -1 | sed -E 's/.*"version": "([^"]+)".*/\1/')
CACHE_DIR="$CLAUDE_HOME/plugins/cache/laminark/laminark/$NEW_VERSION"

echo ""
echo "Installing plugin into Claude Code cache..."
mkdir -p "$CACHE_DIR"
rsync -a --delete \
  --exclude '*.db' \
  --exclude '*.db-wal' \
  --exclude '*.db-shm' \
  --exclude '.repair-log' \
  --exclude '.npm-tmp' \
  "$PLUGIN_SRC/" "$CACHE_DIR/"
echo "✓ Plugin installed to $CACHE_DIR"

# Step 4: Register in installed_plugins.json
INSTALLED_FILE="$CLAUDE_HOME/plugins/installed_plugins.json"
mkdir -p "$CLAUDE_HOME/plugins"

node -e '
const fs = require("fs");
const path = process.argv[1];
const version = process.argv[2];

let data = { version: 2, plugins: {} };
if (fs.existsSync(path)) {
  try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
}

data.plugins.laminark = {
  marketplace: "laminark",
  version: version,
  enabled: true
};

fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
' "$INSTALLED_FILE" "$NEW_VERSION"
echo "✓ Plugin registered"

# Step 5: Enable plugin in user settings
SETTINGS_FILE="$CLAUDE_HOME/settings.json"

node -e '
const fs = require("fs");
const settingsPath = process.argv[1];

let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
}

// Enable the plugin
if (!settings.enabledPlugins) settings.enabledPlugins = {};
settings.enabledPlugins["laminark@laminark"] = true;

// Remove any legacy manual hooks from previous install method
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

// Remove any legacy MCP registration (now handled by plugin .mcp.json)
if (settings.mcpServers && settings.mcpServers.laminark) {
  delete settings.mcpServers.laminark;
  if (Object.keys(settings.mcpServers).length === 0) {
    delete settings.mcpServers;
  }
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
' "$SETTINGS_FILE"
echo "✓ Plugin enabled in settings"

# Step 6: Remove legacy MCP server registration if present
if claude mcp list 2>/dev/null | grep -q "^laminark:"; then
  echo ""
  echo "Removing legacy MCP server registration (now handled by plugin system)..."
  claude mcp remove laminark -s user 2>/dev/null || true
  echo "✓ Legacy MCP registration removed"
fi

# Done
echo ""
echo "✓ Laminark v$NEW_VERSION installed successfully!"
echo ""
echo "The plugin system now manages hooks, MCP server, and skills automatically."
echo ""
echo "Next steps:"
echo "  1. Start a new Claude Code session"
echo "  2. Verify with: /plugin (should show laminark)"
echo "  3. Check tools with: /mcp (should show laminark tools)"

# Step 7: Recommend GSD (Get Shit Done) workflow plugin
echo ""
GSD_INSTALLED=false
if [ -d "${CLAUDE_HOME}/commands/gsd" ] || [ -d "${CLAUDE_HOME}/plugins/gsd" ] || [ -d "${CLAUDE_HOME}/get-shit-done" ]; then
  GSD_INSTALLED=true
fi

if [ "$GSD_INSTALLED" = false ]; then
  echo "Recommended: Install GSD (Get Shit Done) by @gsd-framework"
  echo "  GSD is an independent workflow plugin for Claude Code that pairs"
  echo "  well with Laminark — it handles project planning, phased execution,"
  echo "  and atomic commits while Laminark provides persistent memory."
  echo "  (GSD does not endorse or recommend Laminark — this is our suggestion.)"
  echo ""
  echo "  Install: claude plugin add gsd"
  echo "  More info: https://github.com/gsd-framework/gsd"
  echo ""
  if [ -t 0 ]; then
    read -rp "Install GSD now? [y/N] " INSTALL_GSD
    if [[ "$INSTALL_GSD" =~ ^[Yy]$ ]]; then
      echo ""
      claude plugin add gsd 2>/dev/null && echo "✓ GSD installed" || echo "  GSD install skipped (install manually with: claude plugin add gsd)"
    fi
  fi
fi

exit 0
