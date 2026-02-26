#!/bin/bash
# Sync dev plugin build to the cached Claude Code plugin installation.
# Run after `npm run build` to hot-update the running plugin.
#
# Usage: ./plugin/scripts/dev-sync.sh
#
# Note: If you used local-install.sh (symlink mode), this script is
# unnecessary — changes are live immediately. This script is for when
# the cache contains a real copy (e.g. from install.sh).
#
# Static files (UI, hooks) take effect immediately on next page load.
# Compiled server code (dist/) requires a Claude Code session restart.

set -e

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
CACHE_BASE="$CLAUDE_HOME/plugins/cache/laminark/laminark"

# Resolve the repo root (script lives in plugin/scripts/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/plugin"

# Verify source exists
if [ ! -d "$PLUGIN_SRC/dist" ]; then
  echo "Error: plugin/dist/ not found. Run 'npm run build' first."
  exit 1
fi

# Find cached installation(s)
if [ ! -d "$CACHE_BASE" ]; then
  echo "Error: No cached Laminark plugin found at $CACHE_BASE"
  echo "Install Laminark first: ./plugin/scripts/install.sh"
  exit 1
fi

# Sync to every cached version (usually just one)
SYNCED=0
SKIPPED=0
for CACHE_DIR in "$CACHE_BASE"/*/; do
  [ -d "$CACHE_DIR" ] || continue
  VERSION=$(basename "$CACHE_DIR")

  # Skip symlinks (local-install.sh dev mode — already live)
  if [ -L "${CACHE_DIR%/}" ]; then
    echo "Skipped $VERSION (symlink — already live)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  rsync -a --delete \
    --exclude '*.db' \
    --exclude '*.db-wal' \
    --exclude '*.db-shm' \
    --exclude '.repair-log' \
    --exclude '.npm-tmp' \
    --exclude 'node_modules' \
    "$PLUGIN_SRC/" "$CACHE_DIR"

  echo "Synced to $VERSION"
  SYNCED=$((SYNCED + 1))
done

if [ "$SYNCED" -eq 0 ] && [ "$SKIPPED" -eq 0 ]; then
  echo "Error: No version directories found in $CACHE_BASE"
  exit 1
fi

echo ""
if [ "$SYNCED" -gt 0 ]; then
  echo "Done. $SYNCED cached installation(s) updated."
  echo "UI changes are live. API changes need a session restart."
fi
if [ "$SKIPPED" -gt 0 ]; then
  echo "$SKIPPED symlinked installation(s) skipped (already live)."
fi
