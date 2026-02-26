#!/bin/bash
# Update Laminark to the latest version
# Updates the npm package and uses the plugin system to refresh the cache

set -e

echo "Laminark Updater"
echo "================"
echo ""

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"

# Check if npm is available
if ! command -v npm &> /dev/null; then
  echo "Error: npm not found"
  exit 1
fi

# Check if installed
CURRENT_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "")
if [ -z "$CURRENT_VERSION" ]; then
  echo "Laminark is not installed globally."
  echo "Run: ./plugin/scripts/install.sh"
  exit 1
fi

echo "Currently installed: v$CURRENT_VERSION"
echo ""
echo "Updating npm package..."
npm update -g laminark

NEW_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "unknown")

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  echo "✓ Already at latest version: v$NEW_VERSION"
else
  echo "✓ npm updated: v$CURRENT_VERSION → v$NEW_VERSION"

  # Update via plugin system if marketplace is registered
  if command -v claude &> /dev/null; then
    echo ""
    echo "Updating plugin cache..."

    # Update the marketplace to pick up new version
    claude plugin marketplace update laminark 2>/dev/null || true

    # Update the plugin via the official system
    claude plugin update laminark@laminark 2>/dev/null || {
      # Fallback: uninstall and reinstall
      claude plugin uninstall laminark@laminark 2>/dev/null || true
      claude plugin install laminark@laminark 2>/dev/null || true
    }

    echo "✓ Plugin cache updated to v$NEW_VERSION"
  fi
fi

# CLAUDE.md instructions are auto-updated on next MCP server start
# (handled by ensure-deps.sh — no manual step needed)

echo ""
echo "Restart your Claude Code session for changes to take effect."

exit 0
