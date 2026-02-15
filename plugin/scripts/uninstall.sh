#!/bin/bash
# Uninstall Laminark plugin with optional data cleanup

set -e

echo "Laminark Uninstaller"
echo "===================="
echo ""

# Check if claude CLI is available
if ! command -v claude &> /dev/null; then
  echo "Error: claude CLI not found"
  echo "Please install Claude Code first: https://claude.com/claude-code"
  exit 1
fi

# Check if plugin is installed
if ! claude plugin list 2>/dev/null | grep -q "laminark"; then
  echo "Laminark plugin is not installed."
  exit 0
fi

# Get current version
CURRENT_VERSION=$(claude plugin list 2>/dev/null | grep "laminark" | awk '{print $2}' || echo "unknown")
echo "Currently installed: laminark v$CURRENT_VERSION"
echo ""

# Ask for confirmation
read -p "Are you sure you want to uninstall Laminark? (y/N): " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Uninstall cancelled."
  exit 0
fi

# Remove the plugin
echo "Removing plugin..."
claude plugin remove laminark
echo "✓ Plugin removed"

# Ask about data cleanup
echo ""
echo "Data cleanup options:"
echo "  1. Keep all data (can reinstall later without losing memories)"
echo "  2. Remove plugin cache only (keeps user data at ~/.laminark/)"
echo "  3. Remove everything (plugin cache + all memories and data)"
echo ""
read -p "Choose option (1-3, default=1): " -n 1 -r CLEANUP_OPTION
echo ""

case $CLEANUP_OPTION in
  2)
    echo "Removing plugin cache..."
    CACHE_DIR="${CLAUDE_HOME:-$HOME/.claude}/plugins/cache/laminark"
    if [ -d "$CACHE_DIR" ]; then
      rm -rf "$CACHE_DIR"
      echo "✓ Plugin cache removed: $CACHE_DIR"
    else
      echo "  No cache directory found"
    fi
    ;;
  3)
    echo "Removing all data..."
    CACHE_DIR="${CLAUDE_HOME:-$HOME/.claude}/plugins/cache/laminark"
    DATA_DIR="$HOME/.laminark"

    if [ -d "$CACHE_DIR" ]; then
      rm -rf "$CACHE_DIR"
      echo "✓ Plugin cache removed: $CACHE_DIR"
    fi

    if [ -d "$DATA_DIR" ]; then
      echo ""
      echo "WARNING: This will delete all your memories and observations!"
      read -p "Delete $DATA_DIR? (y/N): " -n 1 -r
      echo ""
      if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$DATA_DIR"
        echo "✓ Data directory removed: $DATA_DIR"
      else
        echo "  Kept data directory: $DATA_DIR"
      fi
    fi
    ;;
  *)
    echo "Keeping all data."
    ;;
esac

echo ""
echo "✓ Uninstall complete!"
echo ""
echo "To reinstall: ./scripts/local-install.sh or ./scripts/install.sh"

exit 0
