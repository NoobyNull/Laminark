#!/bin/bash
# Local development installation for Laminark
# Uses npm link + MCP server registration + hooks pointing at repo dist/
#
# Usage: ./plugin/scripts/local-install.sh [path-to-laminark]
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
if [ ! -d "$PLUGIN_PATH/plugin/dist" ]; then
  echo "Error: plugin/dist/ directory not found in $PLUGIN_PATH"
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
  echo "Version: v$NEW_VERSION"
fi

# Step 1: npm link from repo root
echo ""
echo "Linking package globally..."
cd "$PLUGIN_PATH"
npm link
echo "✓ npm link complete"

# Step 2: Register MCP server
echo ""
echo "Registering MCP server with Claude Code..."
claude mcp add-json laminark '{"command":"laminark-server"}' -s user
echo "✓ MCP server registered"

# Step 3: Configure hooks using repo's dist/hooks/handler.js
echo ""
echo "Configuring hooks (dev mode - pointing at repo)..."
SETTINGS_FILE="${CLAUDE_HOME:-$HOME/.claude}/settings.json"
HANDLER_PATH="$PLUGIN_PATH/plugin/dist/hooks/handler.js"

node -e '
const fs = require("fs");
const settingsPath = process.argv[1];
const handlerPath = process.argv[2];
const hookCmd = `node "${handlerPath}"`;

let settings = {};
if (fs.existsSync(settingsPath)) {
  settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
}

if (!settings.hooks) settings.hooks = {};

const hookEvents = {
  SessionStart: { type: "command", command: hookCmd, statusMessage: "Loading Laminark memory context...", timeout: 10 },
  PreToolUse:   { type: "command", command: hookCmd, timeout: 2 },
  PostToolUse:  { type: "command", command: hookCmd, async: true, timeout: 30 },
  PostToolUseFailure: { type: "command", command: hookCmd, async: true, timeout: 30 },
  Stop:         { type: "command", command: hookCmd, async: true, timeout: 15 },
  SessionEnd:   { type: "command", command: hookCmd, async: true, timeout: 15 }
};

for (const [event, hookConfig] of Object.entries(hookEvents)) {
  if (!settings.hooks[event]) settings.hooks[event] = [];

  // Remove any existing laminark hooks for this event
  settings.hooks[event] = settings.hooks[event].filter(entry =>
    !(entry.hooks && entry.hooks.some(h => h.command && h.command.includes("laminark")))
  );

  // Add the dev hook
  settings.hooks[event].push({
    hooks: [hookConfig]
  });
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
' "$SETTINGS_FILE" "$HANDLER_PATH"

echo "✓ Hooks configured (dev: $HANDLER_PATH)"

# Done
echo ""
echo "✓ Laminark v$NEW_VERSION installed locally!"
echo ""
echo "Next steps:"
echo "  1. Start a new Claude Code session"
echo "  2. Verify with: /mcp (should show laminark tools)"
echo ""
echo "To switch to production install: npm install -g laminark && ./plugin/scripts/install.sh"

exit 0
