#!/bin/bash
# Verify Laminark plugin installation
# Checks: plugin registered, enabled status, provides next steps

set -e

echo "Checking Laminark installation..."
echo ""

# Check if claude CLI is available
if ! command -v claude &> /dev/null; then
  echo "✗ Error: claude CLI not found"
  echo "  Please install Claude Code first: https://claude.com/claude-code"
  exit 1
fi

# Check if plugin is registered
if claude plugin list 2>/dev/null | grep -q "laminark"; then
  echo "✓ Plugin registered: laminark"
else
  echo "✗ Plugin not registered"
  echo "  Please run: ./scripts/local-install.sh"
  exit 1
fi

# Check if plugin is enabled
if claude plugin list 2>/dev/null | grep "laminark" | grep -q "enabled"; then
  echo "✓ Plugin enabled"
else
  echo "⚠ Plugin registered but not enabled"
  echo "  Run: claude plugin enable laminark"
fi

echo ""
echo "Installation verified successfully!"
echo ""
echo "Next steps:"
echo "  1. Start a new Claude Code session"
echo "  2. Check MCP tools with: /mcp"
echo "  3. Check hooks with: /hooks"
echo "  4. Try searching memories with: recall"

exit 0
