#!/bin/bash
# Update Laminark to the latest version
#
# Downloads the latest npm package and directly updates the plugin cache.
# Works from inside a Claude Code session (no `claude plugin` commands needed).
#
# Usage: bash /path/to/update.sh
#   or via ensure-deps.sh auto-update check

set -e

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
CACHE_BASE="$CLAUDE_HOME/plugins/cache/laminark/laminark"
MARKETPLACE_BASE="$CLAUDE_HOME/plugins/marketplaces/laminark"

log() { echo "  $1"; }

# Check prerequisites
if ! command -v node &> /dev/null; then
  echo "Error: node not found"
  exit 1
fi
if ! command -v npm &> /dev/null; then
  echo "Error: npm not found"
  exit 1
fi

echo "Laminark Updater"
echo "================"
echo ""

# Detect current installed version from cache
CURRENT_VERSION=""
if [ -d "$CACHE_BASE" ]; then
  CURRENT_VERSION=$(ls -1 "$CACHE_BASE" 2>/dev/null | sort -V | tail -1)
fi

if [ -z "$CURRENT_VERSION" ]; then
  echo "No cached installation found. Run the installer first."
  exit 1
fi

echo "Installed: v$CURRENT_VERSION"

# Check latest version on npm
LATEST_VERSION=$(npm view laminark version 2>/dev/null || echo "")
if [ -z "$LATEST_VERSION" ]; then
  echo "Could not check npm for latest version (offline?)"
  exit 1
fi

echo "Latest:    v$LATEST_VERSION"
echo ""

if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
  echo "Already on the latest version."
  exit 0
fi

# Download and extract the latest package to a temp dir
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Downloading v$LATEST_VERSION..."
npm pack laminark@"$LATEST_VERSION" --pack-destination "$WORK_DIR" 2>/dev/null
TARBALL=$(find "$WORK_DIR" -name "laminark-*.tgz" -maxdepth 1 2>/dev/null | head -1)
if [ -z "$TARBALL" ]; then
  echo "Error: failed to download package"
  exit 1
fi

tar xzf "$TARBALL" -C "$WORK_DIR"
EXTRACTED="$WORK_DIR/package/plugin"

if [ ! -d "$EXTRACTED" ]; then
  echo "Error: plugin directory not found in package"
  exit 1
fi

# Install dependencies in the extracted plugin dir
log "Installing dependencies..."
NPM_TMP="$WORK_DIR/npm-tmp"
mkdir -p "$NPM_TMP"
TMPDIR="$NPM_TMP" npm install --prefix "$EXTRACTED" --omit=dev --ignore-scripts --silent --cache "$NPM_TMP/cache" 2>/dev/null
npm rebuild --prefix "$EXTRACTED" better-sqlite3 --silent 2>/dev/null
rm -rf "$NPM_TMP"

# Verify the handler loads before replacing the cache
if ! (cd "$EXTRACTED" && node -e "import('./dist/hooks/handler.js')" 2>/dev/null); then
  echo "Error: handler verification failed after dependency install"
  echo "The downloaded package may be broken. Aborting."
  exit 1
fi

log "Handler verified."

# Create the new cache directory
NEW_CACHE="$CACHE_BASE/$LATEST_VERSION"
mkdir -p "$NEW_CACHE"

# Preserve data that lives in the cache (db, repair log)
# The actual DB lives at cache/laminark/data/data.db — not version-specific
OLD_CACHE="$CACHE_BASE/$CURRENT_VERSION"

# Copy the new plugin files (everything except node_modules, which we copy separately)
log "Updating cache..."
rsync -a --delete \
  --exclude node_modules \
  --exclude .deps-ok \
  --exclude .repair-log \
  --exclude .orphaned_at \
  --exclude laminark.db \
  "$EXTRACTED/" "$NEW_CACHE/"

# Copy node_modules (with working deps)
rsync -a --delete "$EXTRACTED/node_modules/" "$NEW_CACHE/node_modules/"

# Write sentinel — deps are already verified
echo "$LATEST_VERSION" > "$NEW_CACHE/.deps-ok"

# Update the marketplace source if it exists
if [ -d "$MARKETPLACE_BASE/plugin" ]; then
  rsync -a --delete \
    --exclude node_modules \
    "$EXTRACTED/" "$MARKETPLACE_BASE/plugin/"
  # Update marketplace.json version
  if [ -f "$MARKETPLACE_BASE/.claude-plugin/marketplace.json" ]; then
    node -e '
const fs = require("fs");
const p = process.argv[1];
const v = process.argv[2];
try {
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  if (m.plugins) m.plugins.forEach(p => p.version = v);
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
} catch {}
' "$MARKETPLACE_BASE/.claude-plugin/marketplace.json" "$LATEST_VERSION"
  fi
fi

# Clean up old version cache (if different)
if [ "$CURRENT_VERSION" != "$LATEST_VERSION" ] && [ -d "$OLD_CACHE" ]; then
  rm -rf "$OLD_CACHE"
  log "Removed old cache (v$CURRENT_VERSION)"
fi

# Remove orphan marker if present
rm -f "$NEW_CACHE/.orphaned_at"

# Update version in installed_plugins.json
INSTALLED_FILE="$CLAUDE_HOME/plugins/installed_plugins.json"
if [ -f "$INSTALLED_FILE" ]; then
  node -e '
const fs = require("fs");
const path = process.argv[1];
const version = process.argv[2];

let data = { version: 2, plugins: {} };
try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}

if (!data.plugins.laminark) {
  data.plugins.laminark = { marketplace: "laminark", enabled: true };
}
data.plugins.laminark.version = version;

fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
' "$INSTALLED_FILE" "$LATEST_VERSION"
  log "Plugin registry updated."
fi

# Ensure plugin is enabled in settings.json
SETTINGS_FILE="$CLAUDE_HOME/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  node -e '
const fs = require("fs");
const settingsPath = process.argv[1];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}

if (!settings.enabledPlugins) settings.enabledPlugins = {};
if (!settings.enabledPlugins["laminark@laminark"]) {
  settings.enabledPlugins["laminark@laminark"] = true;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
' "$SETTINGS_FILE"
fi

echo ""
echo "Updated: v$CURRENT_VERSION → v$LATEST_VERSION"
echo ""
echo "Restart your Claude Code session for changes to take effect."

exit 0
