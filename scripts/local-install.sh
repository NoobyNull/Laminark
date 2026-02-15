#!/bin/bash
# Local installation wrapper for Laminark plugin.
# Works around EXDEV (cross-device rename) errors on btrfs subvolumes,
# separate /tmp partitions, and other cross-device setups.
#
# Usage: ./scripts/local-install.sh [path-to-laminark]
#   Default path: current directory (.)

set -e

# Parse path argument (default to current directory)
PLUGIN_PATH="${1:-.}"

# Resolve to absolute path
if [[ "$PLUGIN_PATH" != /* ]]; then
  PLUGIN_PATH="$(cd "$PLUGIN_PATH" && pwd)"
fi

echo "Laminark Local Installer"
echo "========================"
echo ""
echo "Installing from: $PLUGIN_PATH"

# Validate prerequisites
if [ ! -d "$PLUGIN_PATH/dist" ]; then
  echo "Error: dist/ directory not found in $PLUGIN_PATH"
  echo "Please run 'npm install && npm run build' first"
  exit 1
fi

if ! command -v claude &> /dev/null; then
  echo "Error: claude CLI not found"
  echo "Please install Claude Code first: https://claude.com/claude-code"
  exit 1
fi

# Get version from package.json
if [ -f "$PLUGIN_PATH/package.json" ]; then
  NEW_VERSION=$(grep '"version"' "$PLUGIN_PATH/package.json" | head -1 | sed -E 's/.*"version": "([^"]+)".*/\1/')
  echo "Version to install: v$NEW_VERSION"
else
  NEW_VERSION="unknown"
fi

# Check if already installed
if claude plugin list 2>/dev/null | grep -q "laminark"; then
  CURRENT_VERSION=$(claude plugin list 2>/dev/null | grep "laminark" | awk '{print $2}' || echo "unknown")
  echo "Currently installed: v$CURRENT_VERSION"
  echo ""

  if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
    echo "Same version is already installed."
    read -p "Reinstall anyway? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Installation cancelled."
      exit 0
    fi
  else
    echo "An existing version is installed."
    read -p "Update from v$CURRENT_VERSION to v$NEW_VERSION? (Y/n): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Nn]$ ]]; then
      echo "Installation cancelled."
      exit 0
    fi
  fi

  echo "Removing existing installation..."
  TMPDIR="$SAFE_TMP" claude plugin remove laminark 2>/dev/null || true
fi

# Set up safe temp directory on same filesystem as ~/.claude/
CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
SAFE_TMP="$CLAUDE_DIR/tmp"

echo ""
echo "Creating temporary directory: $SAFE_TMP"
mkdir -p "$SAFE_TMP"

# Run claude plugin add with TMPDIR override
echo "Running: claude plugin add $PLUGIN_PATH"
TMPDIR="$SAFE_TMP" claude plugin add "$PLUGIN_PATH"
STATUS=$?

# Clean up
rm -rf "$SAFE_TMP"

if [ $STATUS -eq 0 ]; then
  echo ""
  echo "✓ Laminark plugin installed successfully!"
  echo ""
  echo "Next steps:"
  echo "  1. Enable the plugin: claude plugin enable laminark"
  echo "  2. Start a new Claude Code session"
  echo "  3. Verify with: /mcp (should show laminark tools)"
else
  echo ""
  echo "✗ Installation failed with exit code $STATUS"
  exit $STATUS
fi

exit 0
