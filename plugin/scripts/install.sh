#!/bin/bash
# Install Laminark as a Claude Code plugin
#
# Installs the npm package globally, registers it as a marketplace,
# then installs the plugin through the official Claude Code plugin system.
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

# Step 2: Locate the installed package
NPM_GLOBAL_ROOT=$(npm root -g)
LAMINARK_ROOT="$NPM_GLOBAL_ROOT/laminark"

if [ ! -d "$LAMINARK_ROOT/plugin" ]; then
  echo "Error: Plugin directory not found at $LAMINARK_ROOT/plugin"
  echo "npm install may have failed."
  exit 1
fi

NEW_VERSION=$(node -e "console.log(require('$LAMINARK_ROOT/package.json').version)")
echo "  Version: $NEW_VERSION"

# Step 3: Remove legacy installations
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
SETTINGS_FILE="$CLAUDE_HOME/settings.json"

# Remove legacy manual hooks and MCP registrations from settings
if [ -f "$SETTINGS_FILE" ]; then
  node -e '
const fs = require("fs");
const settingsPath = process.argv[1];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}

let changed = false;

// Remove legacy manual hooks
if (settings.hooks) {
  for (const [event, entries] of Object.entries(settings.hooks)) {
    const filtered = entries.filter(entry =>
      !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes("laminark")))
    );
    if (filtered.length !== entries.length) {
      settings.hooks[event] = filtered;
      changed = true;
    }
    if (settings.hooks[event].length === 0) {
      delete settings.hooks[event];
    }
  }
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }
}

// Remove legacy MCP registration (now handled by plugin .mcp.json)
if (settings.mcpServers && settings.mcpServers.laminark) {
  delete settings.mcpServers.laminark;
  if (Object.keys(settings.mcpServers).length === 0) {
    delete settings.mcpServers;
  }
  changed = true;
}

if (changed) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log("✓ Removed legacy hooks/MCP from settings");
}
' "$SETTINGS_FILE"
fi

# Remove legacy MCP server registration
if claude mcp list 2>/dev/null | grep -q "^laminark:"; then
  echo "Removing legacy MCP server registration..."
  claude mcp remove laminark -s user 2>/dev/null || true
  echo "✓ Legacy MCP registration removed"
fi

# Step 4: Register the npm package as a marketplace source
echo ""
echo "Registering laminark marketplace..."

# Remove existing marketplace registration to force re-add
claude plugin marketplace remove laminark 2>/dev/null || true
claude plugin marketplace add "$LAMINARK_ROOT"
echo "✓ Marketplace registered"

# Step 5: Install the plugin via Claude Code's plugin system
echo ""
echo "Installing plugin..."

# Uninstall first to avoid conflicts
claude plugin uninstall laminark@laminark 2>/dev/null || true
claude plugin install laminark@laminark
echo "✓ Plugin installed"

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

# Step 6: Recommend GSD (Get Shit Done) workflow plugin
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
