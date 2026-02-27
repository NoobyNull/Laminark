#!/bin/bash
# Update Laminark to the latest version
#
# Uses npm to download the package, then installs deps in-place.
# Works from inside a Claude Code session.
#
# Usage: bash /path/to/update.sh

set -e

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
MARKETPLACE_BASE="$CLAUDE_HOME/plugins/marketplaces/laminark"
INSTALLED_FILE="$CLAUDE_HOME/plugins/installed_plugins.json"

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

# Detect current installed version from plugin.json (the source of truth)
CURRENT_VERSION=""
PLUGIN_JSON="$MARKETPLACE_BASE/plugin/.claude-plugin/plugin.json"
if [ -f "$PLUGIN_JSON" ]; then
  CURRENT_VERSION=$(node -e "console.log(require('$PLUGIN_JSON').version || '')" 2>/dev/null || echo "")
fi

if [ -z "$CURRENT_VERSION" ]; then
  echo "No installation found. Run the installer first."
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

# Download and extract via npm pack (simplest way to get a clean copy)
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
PKG_ROOT="$WORK_DIR/package"
EXTRACTED="$PKG_ROOT/plugin"

if [ ! -d "$EXTRACTED" ]; then
  echo "Error: plugin directory not found in package"
  exit 1
fi

# Install dependencies
log "Installing dependencies..."
NPM_TMP="$WORK_DIR/npm-tmp"
mkdir -p "$NPM_TMP"
TMPDIR="$NPM_TMP" npm install --prefix "$EXTRACTED" --omit=dev --ignore-scripts --silent --cache "$NPM_TMP/cache" 2>/dev/null
npm rebuild --prefix "$EXTRACTED" better-sqlite3 --silent 2>/dev/null
rm -rf "$NPM_TMP"

# Verify handler loads before replacing anything
if ! (cd "$EXTRACTED" && node -e "import('./dist/hooks/handler.js')" 2>/dev/null); then
  echo "Error: handler verification failed. Aborting."
  exit 1
fi
log "Handler verified."

# Update marketplace in-place — just overwrite with the new package contents
log "Updating plugin files..."

# Plugin dir: sync new files, preserve node_modules we just built
if [ -d "$MARKETPLACE_BASE/plugin/node_modules" ]; then
  rm -rf "$MARKETPLACE_BASE/plugin/node_modules"
fi
rsync -a --delete \
  --exclude node_modules \
  "$EXTRACTED/" "$MARKETPLACE_BASE/plugin/" 2>/dev/null \
  || { rm -rf "$MARKETPLACE_BASE/plugin" && cp -a "$EXTRACTED" "$MARKETPLACE_BASE/plugin"; }

# Move in the verified node_modules
mv "$EXTRACTED/node_modules" "$MARKETPLACE_BASE/plugin/node_modules"

# Copy repo-level files (README, package.json, etc.)
for f in .gitignore README.md CHANGELOG.md package.json; do
  [ -f "$PKG_ROOT/$f" ] && cp "$PKG_ROOT/$f" "$MARKETPLACE_BASE/$f" 2>/dev/null || true
done

# Update marketplace.json version
if [ -f "$MARKETPLACE_BASE/.claude-plugin/marketplace.json" ]; then
  node -e '
const fs = require("fs");
const p = process.argv[1], v = process.argv[2];
try {
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  if (m.plugins) m.plugins.forEach(p => p.version = v);
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
} catch {}
' "$MARKETPLACE_BASE/.claude-plugin/marketplace.json" "$LATEST_VERSION"
fi

# Write deps sentinel
echo "$LATEST_VERSION" > "$MARKETPLACE_BASE/plugin/.deps-ok"

# Update installed_plugins.json version
if [ -f "$INSTALLED_FILE" ]; then
  node -e '
const fs = require("fs");
const path = process.argv[1], version = process.argv[2];
let data = { version: 2, plugins: {} };
try { data = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
if (!data.plugins.laminark) data.plugins.laminark = { marketplace: "laminark", enabled: true };
data.plugins.laminark.version = version;
fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
' "$INSTALLED_FILE" "$LATEST_VERSION"
fi

echo ""
echo "Updated: v$CURRENT_VERSION -> v$LATEST_VERSION"
echo ""
echo "Restart your Claude Code session for changes to take effect."

exit 0
