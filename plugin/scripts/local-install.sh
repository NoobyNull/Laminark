#!/bin/bash
# Local development installation for Laminark
#
# Creates a symlink from the repo's plugin/ directory into the Claude Code
# plugin cache, so changes take effect without copying files.
#
# Usage: ./plugin/scripts/local-install.sh [path-to-laminark-repo]
#   Default path: current directory (.)

set -e

# Parse path argument (default to current directory)
REPO_PATH="${1:-.}"

# Resolve to absolute path
if [[ "$REPO_PATH" != /* ]]; then
  REPO_PATH="$(cd "$REPO_PATH" && pwd)"
fi

PLUGIN_SRC="$REPO_PATH/plugin"

echo "Laminark Local Installer (Dev Mode)"
echo "===================================="
echo ""
echo "Repo: $REPO_PATH"

# Validate prerequisites
if [ ! -d "$PLUGIN_SRC/dist" ]; then
  echo "Error: plugin/dist/ directory not found"
  echo "Please run 'npm install && npm run build' first"
  exit 1
fi

if [ ! -f "$PLUGIN_SRC/.claude-plugin/plugin.json" ]; then
  echo "Error: plugin/.claude-plugin/plugin.json not found"
  exit 1
fi

if ! command -v claude &> /dev/null; then
  echo "Error: claude CLI not found"
  echo "Please install Claude Code first: https://claude.com/claude-code"
  exit 1
fi

# Get version from package.json
NEW_VERSION=$(grep '"version"' "$REPO_PATH/package.json" | head -1 | sed -E 's/.*"version": "([^"]+)".*/\1/')
echo "Version: v$NEW_VERSION"

# Step 1: npm link from repo root (optional — only for CLI bin entries)
echo ""
echo "Linking package globally..."
cd "$REPO_PATH"
if npm link 2>/dev/null; then
  echo "✓ npm link complete"
else
  echo "⚠ npm link failed (permission issue) — skipping"
  echo "  This is fine for dev mode. The plugin system doesn't need global bin entries."
fi

# Step 2: Create symlink in plugin cache
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
CACHE_DIR="$CLAUDE_HOME/plugins/cache/laminark/laminark/$NEW_VERSION"

echo ""
echo "Creating plugin symlink in cache..."

# Remove existing cache entry (could be a real dir from previous install)
if [ -e "$CACHE_DIR" ]; then
  rm -rf "$CACHE_DIR"
fi

mkdir -p "$(dirname "$CACHE_DIR")"
ln -sf "$PLUGIN_SRC" "$CACHE_DIR"
echo "✓ Symlinked $CACHE_DIR -> $PLUGIN_SRC"

# Step 3: Register in installed_plugins.json
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

# Step 4: Enable plugin and clean up legacy config
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
echo "✓ Plugin enabled in settings"

# Remove legacy MCP registration if present
if claude mcp list 2>/dev/null | grep -q "^laminark:"; then
  claude mcp remove laminark -s user 2>/dev/null || true
  echo "✓ Legacy MCP registration removed"
fi

# Step 5: CLAUDE.md instructions are auto-provisioned on first MCP server start
# (handled by ensure-deps.sh — no manual step needed)

# Done
echo ""
echo "✓ Laminark v$NEW_VERSION installed locally (dev mode)!"
echo ""
echo "Dev workflow:"
echo "  npm run build    # Rebuild after code changes"
echo "  (symlink means changes are live — no sync needed)"
echo "  API changes still need a Claude Code session restart."
echo ""
echo "Next steps:"
echo "  1. Start a new Claude Code session"
echo "  2. Verify with: /plugin (should show laminark)"
echo "  3. Check tools with: /mcp (should show laminark tools)"

exit 0
