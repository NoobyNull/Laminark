#!/bin/bash
# Verify Laminark installation
# Checks: npm package, plugin cache, settings, dependencies

set -e

echo "Checking Laminark installation..."
echo ""

ERRORS=0
WARNINGS=0
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"

# Check 1: npm global package
NPM_VERSION=$(npm list -g laminark --depth=0 2>/dev/null | grep laminark@ | sed 's/.*@//' || echo "")
if [ -n "$NPM_VERSION" ]; then
  echo "✓ npm package: v$NPM_VERSION"
else
  if command -v laminark-server &> /dev/null; then
    echo "✓ laminark-server on PATH (linked)"
  else
    echo "✗ npm package not installed"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Check 2: Plugin cache
CACHE_BASE="$CLAUDE_HOME/plugins/cache/laminark/laminark"
if [ -d "$CACHE_BASE" ]; then
  for CACHE_DIR in "$CACHE_BASE"/*/; do
    [ -d "$CACHE_DIR" ] || continue
    VERSION=$(basename "$CACHE_DIR")
    if [ -L "${CACHE_DIR%/}" ]; then
      echo "✓ Plugin cache: v$VERSION (symlink/dev)"
    else
      echo "✓ Plugin cache: v$VERSION"
    fi
  done
else
  echo "✗ Plugin cache not found at $CACHE_BASE"
  ERRORS=$((ERRORS + 1))
fi

# Check 3: installed_plugins.json
INSTALLED_FILE="$CLAUDE_HOME/plugins/installed_plugins.json"
if [ -f "$INSTALLED_FILE" ] && grep -q '"laminark"' "$INSTALLED_FILE"; then
  echo "✓ Registered in installed_plugins.json"
else
  echo "✗ Not registered in installed_plugins.json"
  ERRORS=$((ERRORS + 1))
fi

# Check 4: Plugin enabled in settings
SETTINGS_FILE="$CLAUDE_HOME/settings.json"
if [ -f "$SETTINGS_FILE" ] && grep -q '"laminark@laminark"' "$SETTINGS_FILE"; then
  echo "✓ Plugin enabled in settings"
else
  echo "✗ Plugin not enabled in settings"
  ERRORS=$((ERRORS + 1))
fi

# Check 5: Plugin manifest
for CACHE_DIR in "$CACHE_BASE"/*/; do
  [ -d "$CACHE_DIR" ] || continue
  MANIFEST="$CACHE_DIR/.claude-plugin/plugin.json"
  if [ -f "$MANIFEST" ]; then
    echo "✓ Plugin manifest present"
    # Check manifest declares hooks and mcpServers
    if grep -q '"hooks"' "$MANIFEST" && grep -q '"mcpServers"' "$MANIFEST"; then
      echo "✓ Manifest declares hooks and MCP servers"
    else
      echo "⚠ Manifest missing hooks or mcpServers declaration"
      WARNINGS=$((WARNINGS + 1))
    fi
  else
    echo "✗ Plugin manifest missing"
    ERRORS=$((ERRORS + 1))
  fi
  break
done

# Check 6: No legacy configuration
LEGACY=false
if [ -f "$SETTINGS_FILE" ]; then
  if grep -q '"hooks"' "$SETTINGS_FILE" && grep -q "laminark" "$SETTINGS_FILE"; then
    # More precise check: look for laminark in hooks section
    if node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (s.hooks) {
  for (const entries of Object.values(s.hooks)) {
    for (const e of entries) {
      if (e.hooks && e.hooks.some(h => h.command && h.command.includes("laminark"))) {
        process.exit(1);
      }
    }
  }
}
' "$SETTINGS_FILE" 2>/dev/null; then
      echo "✓ No legacy hooks in settings"
    else
      echo "⚠ Legacy hooks found in settings.json (should be managed by plugin system)"
      WARNINGS=$((WARNINGS + 1))
    fi
  else
    echo "✓ No legacy hooks in settings"
  fi
fi

if command -v claude &> /dev/null; then
  if claude mcp list 2>/dev/null | grep -q "^laminark:"; then
    echo "⚠ Legacy MCP server registration found (should be managed by plugin system)"
    WARNINGS=$((WARNINGS + 1))
  else
    echo "✓ No legacy MCP registration"
  fi
fi

# Check 7: Data directory
DATA_DIR="$CLAUDE_HOME/plugins/cache/laminark/data"
if [ -d "$DATA_DIR" ]; then
  echo "✓ Data directory exists"
elif [ -d "$HOME/.laminark" ]; then
  echo "✓ Data directory exists (legacy location)"
else
  echo "⚠ Data directory not yet created (will be created on first use)"
  WARNINGS=$((WARNINGS + 1))
fi

echo ""
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  echo "Installation verified successfully!"
elif [ $ERRORS -eq 0 ]; then
  echo "Installation OK with $WARNINGS warning(s)."
else
  echo "Found $ERRORS error(s) and $WARNINGS warning(s). Run ./plugin/scripts/install.sh to fix."
fi

exit $ERRORS
