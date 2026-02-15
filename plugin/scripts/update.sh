#!/bin/bash
# Update Laminark to the latest version via npm

set -e

echo "Laminark Updater"
echo "================"
echo ""

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
echo "Updating..."
npm update -g laminark

NEW_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "unknown")
echo ""
if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
  echo "✓ Already at latest version: v$NEW_VERSION"
else
  echo "✓ Updated: v$CURRENT_VERSION → v$NEW_VERSION"
fi
echo ""
echo "Restart your Claude Code session for changes to take effect."

exit 0
