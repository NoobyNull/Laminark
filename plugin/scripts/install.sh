#!/bin/bash
# Bootstrap installer for Laminark plugin.
# Works around EXDEV (cross-device rename) errors on btrfs subvolumes,
# separate /tmp partitions, and other cross-device setups.
#
# Usage: curl -fsSL <raw-url> | bash
#   or:  ./scripts/install.sh

set -e

echo "Laminark Marketplace Installer"
echo "==============================="
echo ""

# Check if claude CLI is available
if ! command -v claude &> /dev/null; then
  echo "Error: claude CLI not found"
  echo "Please install Claude Code first: https://claude.com/claude-code"
  exit 1
fi

# Check if already installed
if claude plugin list 2>/dev/null | grep -q "laminark"; then
  CURRENT_VERSION=$(claude plugin list 2>/dev/null | grep "laminark" | awk '{print $2}' || echo "unknown")
  echo "Currently installed: v$CURRENT_VERSION"
  echo ""
  read -p "Update/reinstall? (Y/n): " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Nn]$ ]]; then
    echo "Installation cancelled."
    exit 0
  fi
  echo "Removing existing installation..."
  claude plugin remove laminark 2>/dev/null || true
fi

# Set up TMPDIR to avoid EXDEV errors
CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
SAFE_TMP="$CLAUDE_DIR/tmp"

echo ""
echo "Installing Laminark from marketplace..."
mkdir -p "$SAFE_TMP"
TMPDIR="$SAFE_TMP" claude plugin install laminark
STATUS=$?
rm -rf "$SAFE_TMP"

if [ $STATUS -eq 0 ]; then
  NEW_VERSION=$(claude plugin list 2>/dev/null | grep "laminark" | awk '{print $2}' || echo "unknown")
  echo ""
  echo "✓ Laminark installed successfully! (v$NEW_VERSION)"
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
