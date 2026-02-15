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

echo "Installing Laminark plugin from: $PLUGIN_PATH"

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

# Set up safe temp directory on same filesystem as ~/.claude/
CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
SAFE_TMP="$CLAUDE_DIR/tmp"

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
