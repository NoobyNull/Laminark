#!/bin/bash
# Install Laminark as a Claude Code plugin
#
# Downloads from npm and sets up the marketplace directory structure.
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

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
MARKETPLACE_BASE="$CLAUDE_HOME/plugins/marketplaces/laminark"
SETTINGS_FILE="$CLAUDE_HOME/settings.json"

# Step 1: Download the package
echo "Fetching latest version from npm..."
LATEST_VERSION=$(npm view laminark version 2>/dev/null || echo "")
if [ -z "$LATEST_VERSION" ]; then
  echo "Error: could not fetch version from npm"
  exit 1
fi
echo "  Version: $LATEST_VERSION"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

npm pack laminark@"$LATEST_VERSION" --pack-destination "$WORK_DIR" 2>/dev/null
TARBALL=$(find "$WORK_DIR" -name "laminark-*.tgz" -maxdepth 1 2>/dev/null | head -1)
if [ -z "$TARBALL" ]; then
  echo "Error: failed to download package"
  exit 1
fi

tar xzf "$TARBALL" -C "$WORK_DIR"
PKG_ROOT="$WORK_DIR/package"
EXTRACTED="$PKG_ROOT/plugin"

if [ ! -d "$EXTRACTED" ]; then
  echo "Error: plugin directory not found in package"
  exit 1
fi
echo "  Downloaded."

# Step 2: Install dependencies
echo ""
echo "Installing dependencies..."
NPM_TMP="$WORK_DIR/npm-tmp"
mkdir -p "$NPM_TMP"
TMPDIR="$NPM_TMP" npm install --prefix "$EXTRACTED" --omit=dev --ignore-scripts --silent --cache "$NPM_TMP/cache" 2>/dev/null
npm rebuild --prefix "$EXTRACTED" better-sqlite3 --silent 2>/dev/null
rm -rf "$NPM_TMP"

# Verify the handler loads
if ! (cd "$EXTRACTED" && node -e "import('./dist/hooks/handler.js')" 2>/dev/null); then
  echo "Error: handler verification failed"
  exit 1
fi
echo "  Dependencies verified."

# Step 3: Remove legacy installations
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
  console.log("  Removed legacy hooks/MCP from settings");
}
' "$SETTINGS_FILE"
fi

# Step 4: Set up the marketplace directory
echo ""
echo "Installing plugin..."

mkdir -p "$MARKETPLACE_BASE/.claude-plugin"
mkdir -p "$MARKETPLACE_BASE/plugin"

# Copy plugin files (with deps)
rsync -a --delete "$EXTRACTED/" "$MARKETPLACE_BASE/plugin/" 2>/dev/null \
  || { rm -rf "$MARKETPLACE_BASE/plugin" && cp -a "$EXTRACTED" "$MARKETPLACE_BASE/plugin"; }

# Write deps sentinel
echo "$LATEST_VERSION" > "$MARKETPLACE_BASE/plugin/.deps-ok"

# Write marketplace.json
cat > "$MARKETPLACE_BASE/.claude-plugin/marketplace.json" << MKJSON
{
  "name": "laminark",
  "owner": {
    "name": "NoobyNull"
  },
  "plugins": [
    {
      "name": "laminark",
      "source": "./plugin",
      "description": "Persistent adaptive memory for Claude Code. Automatic observation capture, semantic search, topic detection, knowledge graph, and web visualization.",
      "version": "$LATEST_VERSION",
      "category": "productivity"
    }
  ]
}
MKJSON

# Copy repo-level files
for f in .gitignore README.md CHANGELOG.md package.json; do
  [ -f "$PKG_ROOT/$f" ] && cp "$PKG_ROOT/$f" "$MARKETPLACE_BASE/$f" 2>/dev/null || true
done

echo "  Plugin installed."

# Step 5: Register with Claude Code
echo ""
echo "Registering plugin..."

REGISTERED=false

# Try the CLI first (only works outside a Claude Code session)
if command -v claude &> /dev/null && [ -z "$CLAUDECODE" ]; then
  claude plugin marketplace remove laminark 2>/dev/null || true
  claude plugin marketplace add "$MARKETPLACE_BASE" 2>/dev/null || true
  claude plugin uninstall laminark@laminark 2>/dev/null || true
  if claude plugin install laminark@laminark 2>/dev/null; then
    REGISTERED=true
    echo "  Registered via CLI."
  fi
fi

# Fallback: write registration files directly
if [ "$REGISTERED" = false ]; then
  INSTALLED_FILE="$CLAUDE_HOME/plugins/installed_plugins.json"
  mkdir -p "$CLAUDE_HOME/plugins"

  node -e '
const fs = require("fs");
const path = process.argv[1], version = process.argv[2];
let data = { version: 2, plugins: {} };
if (fs.existsSync(path)) {
  try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
}
data.plugins.laminark = { marketplace: "laminark", version: version, enabled: true };
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
' "$INSTALLED_FILE" "$LATEST_VERSION"

  # Enable in settings.json
  node -e '
const fs = require("fs");
const settingsPath = process.argv[1];
let settings = {};
if (fs.existsSync(settingsPath)) {
  try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
}
if (!settings.enabledPlugins) settings.enabledPlugins = {};
settings.enabledPlugins["laminark@laminark"] = true;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
' "$SETTINGS_FILE"

  echo "  Registered via direct file write."
fi

# Clean up orphaned cache dirs from old install approach
OLD_CACHE="$CLAUDE_HOME/plugins/cache/laminark/laminark"
if [ -d "$OLD_CACHE" ]; then
  rm -rf "$OLD_CACHE"
  echo "  Cleaned up legacy cache."
fi

# Done
echo ""
echo "Laminark v$LATEST_VERSION installed successfully!"
echo ""
echo "Next steps:"
echo "  1. Start a new Claude Code session"
echo "  2. Verify with: /plugin (should show laminark)"
echo "  3. Check tools with: /mcp (should show laminark tools)"

# Recommend GSD
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
      claude plugin add gsd 2>/dev/null && echo "  GSD installed" || echo "  GSD install skipped (install manually with: claude plugin add gsd)"
    fi
  fi
fi

exit 0
