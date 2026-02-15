#!/bin/bash
# Verify Laminark installation
# Checks: npm global package, MCP server, hooks in settings.json

set -e

echo "Checking Laminark installation..."
echo ""

ERRORS=0

# Check 1: npm global package
NPM_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "")
if [ -n "$NPM_VERSION" ]; then
  echo "✓ npm package: v$NPM_VERSION"
else
  # Check for npm link (dev install)
  if command -v laminark-server &> /dev/null; then
    echo "✓ laminark-server on PATH (linked)"
  else
    echo "✗ npm package not installed"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Check 2: laminark-server binary
if command -v laminark-server &> /dev/null; then
  echo "✓ laminark-server binary available"
else
  echo "✗ laminark-server not found on PATH"
  ERRORS=$((ERRORS + 1))
fi

# Check 3: laminark-hook binary
if command -v laminark-hook &> /dev/null; then
  echo "✓ laminark-hook binary available"
else
  echo "⚠ laminark-hook not on PATH (hooks may use direct node path)"
fi

# Check 4: Claude CLI
if ! command -v claude &> /dev/null; then
  echo "✗ claude CLI not found"
  ERRORS=$((ERRORS + 1))
else
  # Check 5: MCP server registration
  if claude mcp list 2>/dev/null | grep -q "laminark"; then
    echo "✓ MCP server registered"
  else
    echo "✗ MCP server not registered"
    echo "  Run: claude mcp add-json laminark '{\"command\":\"laminark-server\"}' -s user"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Check 6: Hooks in settings.json
SETTINGS_FILE="${CLAUDE_HOME:-$HOME/.claude}/settings.json"
if [ -f "$SETTINGS_FILE" ]; then
  if grep -q "laminark" "$SETTINGS_FILE"; then
    echo "✓ Hooks configured in settings.json"
  else
    echo "✗ No laminark hooks in settings.json"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "✗ Settings file not found: $SETTINGS_FILE"
  ERRORS=$((ERRORS + 1))
fi

# Check 7: Data directory
DATA_DIR="$HOME/.laminark"
if [ -d "$DATA_DIR" ]; then
  echo "✓ Data directory exists: $DATA_DIR"
else
  echo "⚠ Data directory not yet created (will be created on first use)"
fi

echo ""
if [ $ERRORS -eq 0 ]; then
  echo "Installation verified successfully!"
  echo ""
  echo "Start a new Claude Code session to use Laminark."
else
  echo "Found $ERRORS issue(s). Run ./plugin/scripts/install.sh to fix."
fi

exit $ERRORS
