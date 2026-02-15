#!/bin/bash
# Update Laminark plugin to the latest version

set -e

echo "Laminark Update Checker"
echo "======================="
echo ""

# Check if claude CLI is available
if ! command -v claude &> /dev/null; then
  echo "Error: claude CLI not found"
  echo "Please install Claude Code first: https://claude.com/claude-code"
  exit 1
fi

# Check if plugin is installed
if ! claude plugin list 2>/dev/null | grep -q "laminark"; then
  echo "Laminark is not installed."
  echo "Run ./scripts/install.sh to install it."
  exit 1
fi

# Get current version
CURRENT_VERSION=$(claude plugin list 2>/dev/null | grep "laminark" | awk '{print $2}' || echo "unknown")
echo "Currently installed: v$CURRENT_VERSION"

# Check for updates (try to get latest version from GitHub)
echo "Checking for updates..."
LATEST_VERSION=$(curl -fsSL https://api.github.com/repos/NoobyNull/Laminark/releases/latest 2>/dev/null | grep '"tag_name"' | sed -E 's/.*"v?([^"]+)".*/\1/' || echo "")

if [ -z "$LATEST_VERSION" ]; then
  echo "Warning: Could not check for updates (GitHub API unavailable)"
  echo ""
  read -p "Force reinstall anyway? (y/N): " -n 1 -r
  echo ""
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Update cancelled."
    exit 0
  fi
  FORCE_UPDATE=true
else
  echo "Latest available: v$LATEST_VERSION"
  echo ""

  # Compare versions
  if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ]; then
    echo "You already have the latest version!"
    echo ""
    read -p "Reinstall anyway? (y/N): " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      echo "Update cancelled."
      exit 0
    fi
  fi
fi

# Set up TMPDIR to avoid EXDEV errors
CLAUDE_DIR="${CLAUDE_HOME:-$HOME/.claude}"
SAFE_TMP="$CLAUDE_DIR/tmp"
mkdir -p "$SAFE_TMP"

# Reinstall the plugin
echo ""
echo "Updating Laminark..."
TMPDIR="$SAFE_TMP" claude plugin remove laminark 2>/dev/null || true
TMPDIR="$SAFE_TMP" claude plugin install laminark
STATUS=$?

# Clean up
rm -rf "$SAFE_TMP"

if [ $STATUS -eq 0 ]; then
  NEW_VERSION=$(claude plugin list 2>/dev/null | grep "laminark" | awk '{print $2}' || echo "unknown")
  echo ""
  echo "✓ Laminark updated successfully!"
  echo "  Previous version: v$CURRENT_VERSION"
  echo "  Current version: v$NEW_VERSION"
  echo ""
  echo "Restart your Claude Code session for changes to take effect."
else
  echo ""
  echo "✗ Update failed with exit code $STATUS"
  exit $STATUS
fi

exit 0
